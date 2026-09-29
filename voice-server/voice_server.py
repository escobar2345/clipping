"""
Voice Studio bridge server (Chatterbox TTS + voice conversion).

A small HTTP API that wraps the chatterbox-master Python library so the
Next.js app (Video Studio tab / Voice Studio tab) can do:

  * Text-to-speech (base / multilingual / turbo / nano) with optional
    zero-shot voice cloning (upload a ~10s reference clip).
  * Voice conversion -- take any audio file and re-voice it with a target
    voice.

Models are lazy-loaded once and cached for the lifetime of the process.
The server reports its status through /health so the Next.js app can show
clear "install the deps" guidance when Chatterbox isn't installed yet.
"""

from __future__ import annotations

import os
import tempfile
import threading
import time
import traceback

from flask import Flask, jsonify, request, send_file

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
HOST = os.environ.get("VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICE_PORT", "8788"))

DEVICE = "cpu"
try:
    import torch

    if torch.cuda.is_available():
        DEVICE = "cuda"
    elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        DEVICE = "mps"
except Exception:
    pass

# The model-worker lock: chatterbox generate() calls mutate in-model
# conditioning state, so we serialize generation globally (one at a time).
GEN_LOCK = threading.Lock()
MODEL_LOCK = threading.Lock()
MODELS: dict[str, object] = {}

MAX_UPLOAD_BYTES = 500 * 1024 * 1024  # 500 MB for voice-conversion inputs

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


# --------------------------------------------------------------------------
# Model loading (lazy + cached)
# --------------------------------------------------------------------------
def _chat_importable() -> str | None:
    """Returns None if chatterbox is importable, else a human error string."""
    try:
        import chatterbox  # noqa: F401
        from chatterbox.tts import ChatterboxTTS  # noqa: F401
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: F401
        from chatterbox.tts_turbo import ChatterboxTurboTTS  # noqa: F401
        from chatterbox.vc import ChatterboxVC  # noqa: F401
        return None
    except Exception as exc:  # ModuleNotFoundError etc.
        return (
            "Chatterbox is not installed in this Python environment. "
            f"Install it with:  pip install -r voice-server/requirements.txt\n"
            f"(detail: {exc})"
        )


def get_model(kind: str):
    """Load (once) and return a chatterbox model by kind."""
    with MODEL_LOCK:
        if kind in MODELS:
            return MODELS[kind]

        if kind == "base":
            from chatterbox.tts import ChatterboxTTS
            model = ChatterboxTTS.from_pretrained(device=DEVICE)
        elif kind == "multilingual":
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS
            model = ChatterboxMultilingualTTS.from_pretrained(device=DEVICE, t3_model="v3")
        elif kind == "turbo":
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            model = ChatterboxTurboTTS.from_pretrained(device=DEVICE)
        elif kind == "nano":
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            model = ChatterboxTurboTTS.from_pretrained(device=DEVICE, nano=True)
        elif kind == "vc":
            from chatterbox.vc import ChatterboxVC
            model = ChatterboxVC.from_pretrained(device=DEVICE)
        else:
            raise ValueError(f"Unknown model kind: {kind}")

        MODELS[kind] = model
        return model


def _float_form(name: str, default: float) -> float:
    raw = request.form.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/health")
def health():
    missing = _chat_importable()
    loaded = sorted(MODELS.keys())
    body = {
        "ok": True,
        "ready": missing is None,
        "device": DEVICE,
        "modelsLoaded": loaded,
        "models": ["base", "multilingual", "turbo", "nano", "vc"],
        "error": missing,
        "serverTime": time.time(),
    }
    return jsonify(body)


@app.post("/tts")
def tts():
    err = _chat_importable()
    if err:
        return jsonify({"error": err}), 503

    model_kind = request.form.get("model", "multilingual")
    text = (request.form.get("text") or "").strip()
    language = (request.form.get("language") or "en").strip()

    if not text:
        return jsonify({"error": "No text to synthesize was provided."}), 400

    exaggeration = _float_form("exaggeration", 0.5)
    cfg_weight = _float_form("cfg_weight", 0.5)
    temperature = _float_form("temperature", 0.8)

    voice_ref = request.files.get("voice_ref")
    voice_ref_path = None
    tmpdir = tempfile.mkdtemp(prefix="voice-tts-")
    try:
        if voice_ref and voice_ref.filename:
            voice_ref_path = os.path.join(tmpdir, "voice_ref.wav")
            voice_ref.save(voice_ref_path)

        with GEN_LOCK:
            model = get_model(model_kind)
            sr = int(model.sr)

            if model_kind == "multilingual":
                wav = model.generate(
                    text,
                    language_id=language,
                    audio_prompt_path=voice_ref_path,
                    exaggeration=exaggeration,
                    cfg_weight=cfg_weight,
                    temperature=temperature,
                )
            elif model_kind in ("base", "turbo", "nano"):
                wav = model.generate(
                    text,
                    audio_prompt_path=voice_ref_path,
                    exaggeration=exaggeration,
                    cfg_weight=cfg_weight,
                    temperature=temperature,
                )
            else:
                return jsonify({"error": f"Unknown model kind: {model_kind}"}), 400

        out = os.path.join(tmpdir, "out.wav")
        import torchaudio as ta
        ta.save(out, wav, sr)

        duration_s = round(float(wav.shape[-1]) / sr, 2)
        resp = send_file(out, mimetype="audio/wav", as_attachment=True, download_name="voice-over.wav")
        resp.headers["X-Audio-Sr"] = str(sr)
        resp.headers["X-Audio-Duration"] = str(duration_s)
        resp.headers["X-Model"] = model_kind
        return resp
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": f"TTS generation failed: {exc}"}), 500
    finally:
        import shutil

        def _cleanup():
            time.sleep(10)
            shutil.rmtree(tmpdir, ignore_errors=True)

        threading.Thread(target=_cleanup, daemon=True).start()


@app.post("/vc")
def voice_conversion():
    err = _chat_importable()
    if err:
        return jsonify({"error": err}), 503

    audio = request.files.get("audio")
    target = request.files.get("target_voice")

    if not audio or not audio.filename:
        return jsonify({"error": "No input audio file was provided."}), 400

    tmpdir = tempfile.mkdtemp(prefix="voice-vc-")
    try:
        ext = os.path.splitext(audio.filename or "audio.wav")[1].lower() or ".wav"
        audio_path = os.path.join(tmpdir, "input" + ext)
        audio.save(audio_path)

        target_path = None
        if target and target.filename:
            target_path = os.path.join(tmpdir, "target.wav")
            target.save(target_path)

        with GEN_LOCK:
            model = get_model("vc")
            sr = int(model.sr)
            wav = model.generate(audio=audio_path, target_voice_path=target_path)

        out = os.path.join(tmpdir, "out.wav")
        import torchaudio as ta
        ta.save(out, wav, sr)

        duration_s = round(float(wav.shape[-1]) / sr, 2)
        resp = send_file(out, mimetype="audio/wav", as_attachment=True, download_name="converted-voice.wav")
        resp.headers["X-Audio-Sr"] = str(sr)
        resp.headers["X-Audio-Duration"] = str(duration_s)
        resp.headers["X-Model"] = "vc"
        return resp
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": f"Voice conversion failed: {exc}"}), 500
    finally:
        import shutil

        def _cleanup():
            time.sleep(10)
            shutil.rmtree(tmpdir, ignore_errors=True)

        threading.Thread(target=_cleanup, daemon=True).start()


if __name__ == "__main__":
    print(f"Voice Studio server listening on http://{HOST}:{PORT} (device: {DEVICE})")
    app.run(host=HOST, port=PORT, threaded=True)
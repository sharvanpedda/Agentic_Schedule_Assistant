"""Sarvam AI client — speech-to-text (Saarika) and text-to-speech (Bulbul).

Docs: https://docs.sarvam.ai
Auth: header `api-subscription-key: <SARVAM_API_KEY>` on every request.

Both calls are synchronous REST calls (files/text under Sarvam's REST limits —
~30s audio for STT, ~2500 chars for TTS). That's the right fit for a chat
turn; we're not doing long-form transcription or streaming here.
"""
from __future__ import annotations

import base64

import httpx
from fastapi import HTTPException

from .config import settings

STT_PATH = "/speech-to-text"
TTS_PATH = "/text-to-speech"


class VoiceNotConfigured(Exception):
    pass


def _require_configured() -> None:
    if not settings.voice_enabled:
        raise VoiceNotConfigured(
            "Voice isn't configured on this server — set SARVAM_API_KEY in backend/.env"
        )


def transcribe(audio_bytes: bytes, filename: str, content_type: str) -> str:
    """Send audio to Sarvam Speech-to-Text, return the transcript text.

    Raises VoiceNotConfigured if no API key, or HTTPException on API failure.
    """
    _require_configured()
    headers = {"api-subscription-key": settings.SARVAM_API_KEY}
    data = {"model": settings.SARVAM_STT_MODEL}
    if settings.SARVAM_STT_LANGUAGE:
        data["language_code"] = settings.SARVAM_STT_LANGUAGE
    files = {"file": (filename or "audio.webm", audio_bytes, content_type or "audio/webm")}

    try:
        r = httpx.post(
            f"{settings.SARVAM_BASE_URL}{STT_PATH}",
            headers=headers,
            data=data,
            files=files,
            timeout=settings.SARVAM_TIMEOUT,
        )
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Couldn't reach Sarvam STT: {e}")

    if r.status_code != 200:
        detail = _extract_error(r)
        raise HTTPException(status_code=502, detail=f"Sarvam STT error: {detail}")

    body = r.json()
    text = (body.get("transcript") or "").strip()
    return text


def synthesize(text: str) -> bytes:
    """Send text to Sarvam Text-to-Speech, return raw WAV audio bytes.

    Raises VoiceNotConfigured if no API key, or HTTPException on API failure.
    """
    _require_configured()
    if not text.strip():
        return b""

    # Bulbul REST is capped at ~2500 chars per request; trim defensively so a
    # long agent reply doesn't hard-fail the whole voice reply.
    trimmed = text.strip()
    if len(trimmed) > 2500:
        trimmed = trimmed[:2497] + "..."

    headers = {
        "api-subscription-key": settings.SARVAM_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "inputs": [trimmed],
        "model": settings.SARVAM_TTS_MODEL,
        "target_language_code": settings.SARVAM_TTS_LANGUAGE,
        "speaker": settings.SARVAM_TTS_SPEAKER,
    }

    try:
        r = httpx.post(
            f"{settings.SARVAM_BASE_URL}{TTS_PATH}",
            headers=headers,
            json=payload,
            timeout=settings.SARVAM_TIMEOUT,
        )
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Couldn't reach Sarvam TTS: {e}")

    if r.status_code != 200:
        detail = _extract_error(r)
        raise HTTPException(status_code=502, detail=f"Sarvam TTS error: {detail}")

    body = r.json()
    audios = body.get("audios") or []
    if not audios:
        raise HTTPException(status_code=502, detail="Sarvam TTS returned no audio")
    return base64.b64decode(audios[0])


def _extract_error(r: httpx.Response) -> str:
    try:
        body = r.json()
        err = body.get("error") or {}
        return err.get("message") or str(body)
    except Exception:
        return r.text[:300]

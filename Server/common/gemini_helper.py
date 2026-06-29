import json
import os
import time
import threading
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()


# Module-level client cache keyed by api_key. The google-genai SDK keeps an
# internal httpx.AsyncClient per genai.Client; instantiating a new Client per
# helper call leaks unawaited aclose() coroutines into the event loop on
# Python 3.12 ("Task was destroyed but it is pending! …BaseApiClient.aclose").
# One shared client per api_key eliminates the churn — the SDK reuses HTTP
# connections too, so this is also faster.
_CLIENT_CACHE: dict[str, "genai.Client"] = {}
_CLIENT_LOCK = threading.Lock()

# Per-process cache of Gemini File API handles, keyed by (api_key,
# absolute_local_path, size, mtime_ns). Lets the visual debugger upload a
# page PNG once and reuse it for sentence-locate + pinpoint-locate + fallback
# sweep + downstream calls instead of re-uploading the same bytes 3-5 times.
# Gemini File handles are valid for ~48h, well past any single analyze run,
# so cache hits are essentially free.
_UPLOAD_CACHE: dict[tuple, object] = {}
_UPLOAD_LOCK = threading.Lock()


def _upload_cache_key(api_key: str, file_path: str) -> tuple:
    try:
        st = os.stat(file_path)
        return (api_key, os.path.abspath(file_path), st.st_size, st.st_mtime_ns)
    except OSError:
        return (api_key, os.path.abspath(file_path), 0, 0)


def _get_shared_client(api_key: str) -> "genai.Client":
    with _CLIENT_LOCK:
        client = _CLIENT_CACHE.get(api_key)
        if client is None:
            client = genai.Client(api_key=api_key)
            _CLIENT_CACHE[api_key] = client
        return client


def _wait_until_active(client, f, max_wait_s: float = 30.0):
    """
    Wait for an uploaded file to leave the PROCESSING state.

    Replaces the original `while PROCESSING: time.sleep(2)` loop. For the
    small page-PNGs the visual debugger uploads (~100 KB), the file is
    typically ACTIVE within 100-400 ms — the old 2-second poll wasted at
    least 1.5 s per upload and was the dominant cost in the VD stall
    (thousands of uploads × 1.5 s of dead air = 30+ minutes lost on a
    single parcel).

    Strategy: tiny initial interval, geometric back-off, bail out cleanly
    on FAILED. Total wait is capped so a stuck file can't hang the whole
    analyze.
    """
    if f.state.name != "PROCESSING":
        return f
    interval = 0.1
    deadline = time.monotonic() + max_wait_s
    while f.state.name == "PROCESSING":
        if time.monotonic() > deadline:
            raise TimeoutError(f"Gemini file {f.name} stuck in PROCESSING beyond {max_wait_s}s")
        time.sleep(interval)
        interval = min(interval * 1.7, 1.0)
        f = client.files.get(name=f.name)
    return f


class GeminiHelper:
    """
    Helper class to manage interactions with the Google Gemini API.
    """

    def __init__(self, api_key: str = None, model_id: str = None):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY not found in environment.")

        # Reuse the cached genai.Client for this api_key (see module-level
        # _CLIENT_CACHE) to avoid the per-instance httpx teardown warning.
        self.client = _get_shared_client(self.api_key)
        # Use provided model_id, fallback to GEMINI_MODEL env, then default
        self.model_id = model_id or os.getenv("GEMINI_MODEL") or "gemini-3.5-flash"

    def _upload_cached(self, file_path: str, display_name: str):
        """
        Upload a file via the Gemini File API, returning the ACTIVE handle.
        Repeat calls with the same (path, size, mtime) return the cached
        handle instead of re-uploading — eliminates the 2-5× redundant
        upload pattern in the visual debugger (same page PNG used for
        sentence-locate + pinpoint-locate + fallback sweep).
        """
        key = _upload_cache_key(self.api_key, file_path)
        with _UPLOAD_LOCK:
            cached = _UPLOAD_CACHE.get(key)
        if cached is not None:
            # Verify the cached handle is still ACTIVE before reusing.
            # If Gemini expired it (>48h) or deleted it, fall through to
            # a fresh upload.
            try:
                f = self.client.files.get(name=cached.name)
                if f.state.name == "ACTIVE":
                    return f
            except Exception:
                pass
            with _UPLOAD_LOCK:
                _UPLOAD_CACHE.pop(key, None)

        print(f"[*] Uploading {file_path}...")
        f = self.client.files.upload(
            file=file_path, config=types.UploadFileConfig(display_name=display_name)
        )
        f = _wait_until_active(self.client, f)
        if f.state.name == "FAILED":
            raise ValueError(f"File processing failed for {file_path}")
        print(f"[*] File {display_name} processed. Analyzing...")
        with _UPLOAD_LOCK:
            _UPLOAD_CACHE[key] = f
        return f

    def generate_from_text(
        self, text: str, prompt: str, temperature: float = 0.0, top_p: float = 0.1
    ) -> str:
        """
        Sends a text payload and a prompt to the model.
        """
        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = self.client.models.generate_content(
                    model=self.model_id,
                    contents=[text, prompt],
                    config=types.GenerateContentConfig(
                        temperature=temperature,
                        top_p=top_p
                    ),
                )
                return response.text
            except Exception as e:
                error_msg = str(e)
                error_lower = error_msg.lower()
                is_transient = any(phrase in error_lower for phrase in [
                    "503", "502", "504", "overloaded", "unavailable",
                    "peer closed connection", "incomplete chunked", "connection", "timeout", "reset"
                ])
                if is_transient:
                    if attempt < max_retries - 1:
                        wait_time = 2 ** (attempt + 1)
                        print(f"[!] Gemini transient error. Retrying in {wait_time}s... ({error_msg})")
                        time.sleep(wait_time)
                        continue
                raise e

    def generate_json_from_file(
        self,
        file_path: str,
        prompt: str,
        response_schema: dict,
        display_name: str = "Uploaded File",
        temperature: float = 0.0,
        top_p: float = 0.1,
    ):
        """
        Upload a file and ask Gemini to respond as JSON conforming to
        `response_schema`. Returns the parsed JSON (dict or list).

        The schema follows google-genai's JSON schema dialect -- pass a dict like
        {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {...}}}.
        """
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        f = self._upload_cached(file_path, display_name)

        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = self.client.models.generate_content(
                    model=self.model_id,
                    contents=[f, prompt],
                    config=types.GenerateContentConfig(
                        temperature=temperature,
                        top_p=top_p,
                        response_mime_type="application/json",
                        response_schema=response_schema,
                    ),
                )
                return json.loads(response.text)
            except Exception as e:
                error_lower = str(e).lower()
                is_transient = any(p in error_lower for p in [
                    "503", "502", "504", "overloaded", "unavailable",
                    "peer closed connection", "incomplete chunked", "connection", "timeout", "reset",
                ])
                if is_transient and attempt < max_retries - 1:
                    wait = 2 ** (attempt + 1)
                    print(f"[!] Gemini transient error. Retrying in {wait}s... ({e})")
                    time.sleep(wait)
                    continue
                raise

    def generate_from_file(
        self, file_path: str, prompt: str, display_name: str = "Uploaded File",
        temperature: float = 0.0, top_p: float = 0.1
    ) -> str:
        """
        Uploads a file (e.g., PDF) to Gemini and generates content based on it.
        """
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        f = self._upload_cached(file_path, display_name)

        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = self.client.models.generate_content(
                    model=self.model_id,
                    contents=[f, prompt],
                    config=types.GenerateContentConfig(
                        temperature=temperature,
                        top_p=top_p
                    )
                )
                return response.text
            except Exception as e:
                error_msg = str(e)
                error_lower = error_msg.lower()
                is_transient = any(phrase in error_lower for phrase in [
                    "503", "502", "504", "overloaded", "unavailable",
                    "peer closed connection", "incomplete chunked", "connection", "timeout", "reset"
                ])
                if is_transient:
                    if attempt < max_retries - 1:
                        wait_time = 2 ** (attempt + 1)
                        print(f"[!] Gemini transient error. Retrying in {wait_time}s... ({error_msg})")
                        time.sleep(wait_time)
                        continue
                raise e

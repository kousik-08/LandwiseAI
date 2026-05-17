import json
import os
import time
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()


class GeminiHelper:
    """
    Helper class to manage interactions with the Google Gemini API.
    """

    def __init__(self, api_key: str = None, model_id: str = None):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY not found in environment.")

        self.client = genai.Client(api_key=self.api_key)
        # Use provided model_id, fallback to GEMINI_MODEL env, then default
        self.model_id = model_id or os.getenv("GEMINI_MODEL") or "gemini-2.5-flash-lite"

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

        print(f"[*] Uploading {file_path}...")

        f = self.client.files.upload(
            file=file_path, config=types.UploadFileConfig(display_name=display_name)
        )
        while f.state.name == "PROCESSING":
            time.sleep(2)
            f = self.client.files.get(name=f.name)
        if f.state.name == "FAILED":
            raise ValueError(f"File processing failed for {file_path}")

        print(f"[*] File {display_name} processed. Analyzing...")

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

        print(f"[*] Uploading {file_path}...")

        f = self.client.files.upload(
            file=file_path, config=types.UploadFileConfig(display_name=display_name)
        )

        while f.state.name == "PROCESSING":
            print(".", end="", flush=True)
            time.sleep(2)
            f = self.client.files.get(name=f.name)

        if f.state.name == "FAILED":
            raise ValueError(f"File processing failed for {file_path}")

        print(f"\n[*] File {display_name} processed. Analyzing...")
        
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

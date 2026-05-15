"""
Storage abstraction for inputs/outputs.

Two backends selected by env var STORAGE_BACKEND:
  - 'local' (default): keys are relative paths under Server/.
  - 's3': keys map 1:1 to S3 object keys in S3_BUCKET / S3_REGION.

Keys never start with '/'. Use forward slashes. Existing call sites
build keys like 'outputs/validate/<rid>/results.json' — those work
unchanged against either backend.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import threading
from contextlib import contextmanager
from typing import BinaryIO, ContextManager, List, Optional


def _normalize_key(key: str) -> str:
    return key.replace("\\", "/").lstrip("/")


class Storage:
    backend: str = "base"

    def put_bytes(self, key: str, data: bytes, content_type: Optional[str] = None) -> str:
        raise NotImplementedError

    def put_file(self, key: str, local_path: str, content_type: Optional[str] = None) -> str:
        raise NotImplementedError

    def get_bytes(self, key: str) -> bytes:
        raise NotImplementedError

    def download_to(self, key: str, local_path: str) -> str:
        raise NotImplementedError

    def open_stream(self, key: str) -> BinaryIO:
        raise NotImplementedError

    def exists(self, key: str) -> bool:
        raise NotImplementedError

    def list_prefix(self, prefix: str) -> List[str]:
        raise NotImplementedError

    def delete_prefix(self, prefix: str) -> int:
        raise NotImplementedError

    def presigned_url(self, key: str, expires: int = 3600) -> str:
        raise NotImplementedError

    @contextmanager
    def local_copy(self, key: str) -> ContextManager[str]:
        """
        Yield a real local filesystem path for `key`. For LocalStorage this
        is the actual file. For S3Storage the object is downloaded into
        Server/tmp/ and cleaned up on exit.
        """
        raise NotImplementedError


class LocalStorage(Storage):
    backend = "local"

    def __init__(self, root: str = "."):
        self.root = os.path.abspath(root)

    def _abs(self, key: str) -> str:
        return os.path.join(self.root, _normalize_key(key))

    def put_bytes(self, key, data, content_type=None):
        path = self._abs(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return key

    def put_file(self, key, local_path, content_type=None):
        path = self._abs(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.abspath(local_path) != os.path.abspath(path):
            shutil.copyfile(local_path, path)
        return key

    def get_bytes(self, key):
        with open(self._abs(key), "rb") as f:
            return f.read()

    def download_to(self, key, local_path):
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        src = self._abs(key)
        if os.path.abspath(src) != os.path.abspath(local_path):
            shutil.copyfile(src, local_path)
        return local_path

    def open_stream(self, key):
        return open(self._abs(key), "rb")

    def exists(self, key):
        return os.path.exists(self._abs(key))

    def list_prefix(self, prefix):
        base = self._abs(prefix)
        if os.path.isfile(base):
            return [_normalize_key(prefix)]
        if not os.path.isdir(base):
            return []
        out: List[str] = []
        for dirpath, _, files in os.walk(base):
            for name in files:
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, self.root)
                out.append(_normalize_key(rel))
        return out

    def delete_prefix(self, prefix):
        base = self._abs(prefix)
        n = 0
        if os.path.isfile(base):
            os.remove(base)
            return 1
        if not os.path.isdir(base):
            return 0
        for dirpath, _, files in os.walk(base):
            for name in files:
                os.remove(os.path.join(dirpath, name))
                n += 1
        shutil.rmtree(base, ignore_errors=True)
        return n

    def presigned_url(self, key, expires=3600):
        # For local backend the static endpoint serves directly; callers
        # should prefer using `/files/<key>` URLs constructed elsewhere.
        return f"/files/{_normalize_key(key)}"

    @contextmanager
    def local_copy(self, key):
        yield self._abs(key)


class S3Storage(Storage):
    backend = "s3"

    def __init__(self, bucket: str, region: str, presign_expires: int = 3600):
        import boto3  # imported lazily so local-only dev needn't have boto3 installed
        from botocore.config import Config

        self.bucket = bucket
        self.region = region
        self.presign_expires = presign_expires

        # Force virtual-hosted-style addressing on the regional endpoint so
        # generate_presigned_url emits
        # https://<bucket>.s3.<region>.amazonaws.com/... — not the legacy
        # https://<bucket>.s3.amazonaws.com/... which 301-redirects and
        # breaks browser CORS preflight.
        client_config = Config(
            region_name=region,
            signature_version="s3v4",
            s3={"addressing_style": "virtual"},
        )
        endpoint_url = f"https://s3.{region}.amazonaws.com"

        access_key = os.environ.get("AWS_ACCESS_KEY_ID")
        secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
        session_token = os.environ.get("AWS_SESSION_TOKEN")
        if access_key and secret_key:
            self._client = boto3.client(
                "s3",
                region_name=region,
                endpoint_url=endpoint_url,
                config=client_config,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
                aws_session_token=session_token or None,
            )
        else:
            self._client = boto3.client(
                "s3",
                region_name=region,
                endpoint_url=endpoint_url,
                config=client_config,
            )

    def put_bytes(self, key, data, content_type=None):
        k = _normalize_key(key)
        extra = {"ContentType": content_type} if content_type else {}
        self._client.put_object(Bucket=self.bucket, Key=k, Body=data, **extra)
        return k

    def put_file(self, key, local_path, content_type=None):
        k = _normalize_key(key)
        extra = {"ContentType": content_type} if content_type else {}
        self._client.upload_file(local_path, self.bucket, k, ExtraArgs=extra or None)
        return k

    def get_bytes(self, key):
        obj = self._client.get_object(Bucket=self.bucket, Key=_normalize_key(key))
        return obj["Body"].read()

    def download_to(self, key, local_path):
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        self._client.download_file(self.bucket, _normalize_key(key), local_path)
        return local_path

    def open_stream(self, key):
        obj = self._client.get_object(Bucket=self.bucket, Key=_normalize_key(key))
        return obj["Body"]

    def exists(self, key):
        from botocore.exceptions import ClientError
        try:
            self._client.head_object(Bucket=self.bucket, Key=_normalize_key(key))
            return True
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def list_prefix(self, prefix):
        p = _normalize_key(prefix)
        out: List[str] = []
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=p):
            for obj in page.get("Contents", []) or []:
                out.append(obj["Key"])
        return out

    def delete_prefix(self, prefix):
        keys = self.list_prefix(prefix)
        n = 0
        for i in range(0, len(keys), 1000):
            batch = keys[i : i + 1000]
            self._client.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": [{"Key": k} for k in batch]},
            )
            n += len(batch)
        return n

    def presigned_url(self, key, expires=None):
        return self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": _normalize_key(key)},
            ExpiresIn=expires or self.presign_expires,
        )

    @contextmanager
    def local_copy(self, key):
        tmp_root = os.path.join("tmp", "s3cache")
        os.makedirs(tmp_root, exist_ok=True)
        fd, path = tempfile.mkstemp(dir=tmp_root, suffix=os.path.splitext(key)[1])
        os.close(fd)
        try:
            self.download_to(key, path)
            yield path
        finally:
            try:
                os.remove(path)
            except OSError:
                pass


_storage_singleton: Optional[Storage] = None
_storage_lock = threading.Lock()


def get_storage() -> Storage:
    global _storage_singleton
    if _storage_singleton is not None:
        return _storage_singleton
    with _storage_lock:
        if _storage_singleton is not None:
            return _storage_singleton
        backend = (os.environ.get("STORAGE_BACKEND") or "local").strip().lower()
        if backend == "s3":
            bucket = os.environ.get("S3_BUCKET", "landwise-results")
            region = os.environ.get("S3_REGION", "ap-south-1")
            expires = int(os.environ.get("S3_PRESIGN_EXPIRES", "3600"))
            _storage_singleton = S3Storage(bucket=bucket, region=region, presign_expires=expires)
        else:
            _storage_singleton = LocalStorage(root=".")
        return _storage_singleton


# Convenience module-level helpers
def put_bytes(key, data, content_type=None): return get_storage().put_bytes(key, data, content_type)
def put_file(key, local_path, content_type=None): return get_storage().put_file(key, local_path, content_type)
def get_bytes(key): return get_storage().get_bytes(key)
def download_to(key, local_path): return get_storage().download_to(key, local_path)
def open_stream(key): return get_storage().open_stream(key)
def exists(key): return get_storage().exists(key)
def list_prefix(prefix): return get_storage().list_prefix(prefix)
def delete_prefix(prefix): return get_storage().delete_prefix(prefix)
def presigned_url(key, expires=3600): return get_storage().presigned_url(key, expires)
def local_copy(key): return get_storage().local_copy(key)

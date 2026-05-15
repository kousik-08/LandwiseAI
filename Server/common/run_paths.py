"""
Per-run path resolver.

Local scratch lives under tmp/work/<kind>/<request_id>/ and gets deleted
at the end of every run. The canonical S3 key tree stays at
outputs/<kind>/<request_id>/ and inputs/<kind>/<request_id>/ so nothing
external to the server has to change.

Use:
    rp = RunPaths(processing_id, kind="validate")
    rp.output_dir          # local scratch for outputs/*
    rp.input_dir           # local scratch for inputs/*
    rp.s3_output_prefix    # canonical S3 key prefix for outputs/*
    rp.s3_input_prefix     # canonical S3 key prefix for inputs/*
    rp.sync_outputs()      # uploads scratch -> S3 with correct prefix
    rp.sync_inputs()
    rp.cleanup()           # rm -rf the whole scratch tree
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass

from common.storage_sync import sync_dir


@dataclass
class RunPaths:
    request_id: str
    kind: str = "validate"

    @property
    def _root(self) -> str:
        return os.path.join("tmp", "work", self.kind, self.request_id)

    @property
    def output_dir(self) -> str:
        return self._root  # everything the modules used to write to outputs/<kind>/<rid>/

    @property
    def input_dir(self) -> str:
        return os.path.join(self._root, "_inputs")

    @property
    def s3_output_prefix(self) -> str:
        return f"outputs/{self.kind}/{self.request_id}"

    @property
    def s3_input_prefix(self) -> str:
        return f"inputs/{self.kind}/{self.request_id}"

    def ensure(self) -> "RunPaths":
        os.makedirs(self.output_dir, exist_ok=True)
        os.makedirs(self.input_dir, exist_ok=True)
        return self

    def sync_outputs(self) -> int:
        return sync_dir(self.output_dir, key_prefix=self.s3_output_prefix)

    def sync_inputs(self) -> int:
        return sync_dir(self.input_dir, key_prefix=self.s3_input_prefix)

    def cleanup(self) -> None:
        shutil.rmtree(self._root, ignore_errors=True)

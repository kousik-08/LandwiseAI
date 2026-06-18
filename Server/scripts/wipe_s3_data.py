"""
DESTRUCTIVE: delete objects from the LandwiseAI S3 bucket.

Defaults to the app-data prefixes (inputs/ and outputs/) and runs as a
DRY-RUN. Pass --apply to actually delete. Mirrors the safety convention of
tmp/wipe_data_keep_users.py (dry-run unless --apply).

Usage from Server/:
    python scripts/wipe_s3_data.py                          # dry-run: inputs/ + outputs/
    python scripts/wipe_s3_data.py --apply                  # delete inputs/ + outputs/
    python scripts/wipe_s3_data.py --prefix outputs/ --apply
    python scripts/wipe_s3_data.py --all --apply            # empty the ENTIRE bucket
    python scripts/wipe_s3_data.py --all --versions --apply # also purge versions/markers

Reads S3_BUCKET / S3_REGION and AWS creds from Server/.env. Back up first
(e.g. `aws s3 sync s3://$S3_BUCKET/outputs s3://$S3_BUCKET/backups/...`) — this
is irreversible.
"""
import os
import sys
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_ROOT = os.path.dirname(HERE)
sys.path.insert(0, SERVER_ROOT)
os.chdir(SERVER_ROOT)

from dotenv import load_dotenv
load_dotenv()

# Reuse the project's boto3 client config (virtual addressing, regional
# endpoint, env-var credentials) regardless of STORAGE_BACKEND.
from common.storage import S3Storage

parser = argparse.ArgumentParser(description="Wipe objects from the LandwiseAI S3 bucket.")
parser.add_argument("--apply", action="store_true", help="Actually delete (default: dry-run)")
parser.add_argument("--all", action="store_true", help="Target the ENTIRE bucket, not just app prefixes")
parser.add_argument("--prefix", action="append", default=None,
                    help="Prefix to wipe (repeatable). Default: inputs/ and outputs/")
parser.add_argument("--versions", action="store_true",
                    help="Also purge non-current versions + delete markers (versioned buckets)")
args = parser.parse_args()

bucket = os.environ.get("S3_BUCKET", "landwise-results")
region = os.environ.get("S3_REGION", "ap-south-1")

if args.all:
    prefixes = [""]
elif args.prefix:
    prefixes = args.prefix
else:
    prefixes = ["inputs/", "outputs/"]

print(f"Bucket   : {bucket} ({region})")
print(f"Prefixes : {['<ENTIRE BUCKET>'] if prefixes == [''] else prefixes}")
print(f"Versions : {args.versions}")
print(f"Mode     : {'APPLY (delete)' if args.apply else 'DRY-RUN'}")
print()

client = S3Storage(bucket=bucket, region=region)._client


def _delete_batch(objects):
    """objects: list of {'Key':..[, 'VersionId':..]}. Deletes in chunks of 1000."""
    deleted = 0
    for i in range(0, len(objects), 1000):
        chunk = objects[i:i + 1000]
        if args.apply:
            client.delete_objects(Bucket=bucket, Delete={"Objects": chunk, "Quiet": True})
        deleted += len(chunk)
    return deleted


grand_total = 0
for prefix in prefixes:
    label = prefix or "<entire bucket>"
    to_delete = []
    if args.versions:
        for page in client.get_paginator("list_object_versions").paginate(Bucket=bucket, Prefix=prefix):
            for v in page.get("Versions", []) + page.get("DeleteMarkers", []):
                to_delete.append({"Key": v["Key"], "VersionId": v["VersionId"]})
    else:
        for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                to_delete.append({"Key": obj["Key"]})
    n = _delete_batch(to_delete)
    grand_total += n
    print(f"  {'Deleted' if args.apply else 'Would delete'} {n} objects under '{label}'")

print()
if args.apply:
    print(f"[OK] {grand_total} objects deleted from {bucket}.")
else:
    print(f"Dry-run only. {grand_total} objects would be deleted. Re-run with --apply.")

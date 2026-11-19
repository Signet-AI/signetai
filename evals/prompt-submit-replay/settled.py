import json
import sys

MIGRATION_STARTED = "Migration integrity verify attempt"
MIGRATION_PASSED = "Global integrity check passed"
MIGRATION_FAILED = ("Global integrity check FAILED", "Global integrity check failed")
SLICE = "Incremental database integrity slice complete"
PENDING = ("running", "timed_out", "unavailable")
DEGRADED = "degraded:integrity-unverified"


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(2)


def main():
    migration = None
    incremental = None
    with open(sys.argv[1], errors="ignore") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            message = str(record.get("message", ""))
            if message.startswith(MIGRATION_FAILED) or message == DEGRADED:
                fail(f"migration integrity verification did not pass: {message}")
            if message == MIGRATION_STARTED and migration is None:
                migration = False
            if message.startswith(MIGRATION_PASSED):
                migration = True
            if message == SLICE:
                data = record.get("data") or {}
                if data.get("failedObjects"):
                    fail(f"incremental integrity found {data['failedObjects']} failed objects")
                if data.get("phase") not in PENDING:
                    incremental = data.get("phase")
    if incremental not in (None, "complete"):
        fail(f"incremental integrity ended {incremental}")
    sys.exit(0 if incremental == "complete" and migration is not False else 1)


main()

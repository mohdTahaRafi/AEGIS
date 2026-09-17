"""Entry point for `aegis-eval`. See design.md §18, docs/planning/phase_1_contract_harness.md."""

from __future__ import annotations

import argparse
import sys

from aegis_eval.corpus.labels import (
    canary_ids_are_globally_unique,
    iter_label_files,
    screen_id_matches_folder,
    validate_label_file,
)
from aegis_eval.runner.heldout_guard import HeldOutAccessDeniedError
from aegis_eval.runner.main import run as run_harness


def cmd_run(args: argparse.Namespace) -> int:
    try:
        return run_harness(
            args.split,
            heldout_confirmed=args.i_am_really_using_heldout,
            heldout_reason=args.reason,
            headless=not args.headed,
        )
    except HeldOutAccessDeniedError as exc:
        print(f"error: {exc}")
        return 2


def cmd_validate_labels(_args: argparse.Namespace) -> int:
    files = iter_label_files()
    if not files:
        print("[aegis-eval] no label files found in eval/labels/")
        return 1

    ok = True
    for path in files:
        errors = validate_label_file(path)
        if errors:
            ok = False
            print(f"FAIL {path.name}")
            for e in errors:
                print(f"  - {e}")
            continue
        folder_error = screen_id_matches_folder(path)
        if folder_error:
            ok = False
            print(f"FAIL {folder_error}")

    for e in canary_ids_are_globally_unique(files):
        ok = False
        print(f"FAIL {e}")

    if ok:
        print(f"[aegis-eval] {len(files)} label file(s) valid")
        return 0
    return 1


def main() -> None:
    parser = argparse.ArgumentParser(prog="aegis-eval")
    sub = parser.add_subparsers(dest="command")

    run_p = sub.add_parser("run", help="Run the harness on a corpus split")
    run_p.add_argument("--split", choices=["dev", "heldout"], default="dev")
    run_p.add_argument(
        "--i-am-really-using-heldout",
        action="store_true",
        help="Required (with --reason) to run against the held-out split (design.md §18.4).",
    )
    run_p.add_argument("--reason", help="Why this run needs the held-out split.")
    run_p.add_argument(
        "--headed", action="store_true", help="Launch a visible browser instead of headless."
    )

    sub.add_parser("validate-labels", help="Validate every eval/labels/*.json file")

    args = parser.parse_args()

    if args.command == "run":
        sys.exit(cmd_run(args))
    elif args.command == "validate-labels":
        sys.exit(cmd_validate_labels(args))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

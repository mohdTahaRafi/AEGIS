"""Entry point for `aegis-eval`. Scaffold — see design.md §18, docs/TASKS.md Phase 1 and Phase 5."""

import argparse
import sys


def main() -> None:
    parser = argparse.ArgumentParser(prog="aegis-eval")
    sub = parser.add_subparsers(dest="command")
    run = sub.add_parser("run", help="Run the harness on a corpus split")
    run.add_argument("--split", choices=["dev", "heldout"], default="dev")
    args = parser.parse_args()

    if args.command == "run":
        print(f"[aegis-eval] not implemented yet — see docs/TASKS.md Phase 1/5 (split={args.split})")
        sys.exit(1)
    parser.print_help()


if __name__ == "__main__":
    main()

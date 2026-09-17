"""These checksums are foundational to the whole fixture corpus — every 'valid identifier' fixture
depends on them being genuinely correct, and every 'hard negative' fixture depends on them
genuinely rejecting a mutated value. Tested before anything is built on top of them."""

import random

from aegis_eval.corpus.checksums import (
    gstin_generate,
    gstin_valid,
    luhn_generate,
    luhn_valid,
    verhoeff_generate,
    verhoeff_valid,
)


def test_verhoeff_round_trip_many_random_bases() -> None:
    rng = random.Random(42)
    for _ in range(200):
        base = "".join(str(rng.randint(0, 9)) for _ in range(11))
        check = verhoeff_generate(base)
        assert verhoeff_valid(base + check)


def test_verhoeff_detects_every_single_digit_change() -> None:
    rng = random.Random(7)
    for _ in range(50):
        base = "".join(str(rng.randint(0, 9)) for _ in range(11))
        number = base + verhoeff_generate(base)
        for pos in range(12):
            for new_digit in range(10):
                if new_digit == int(number[pos]):
                    continue
                mutated = number[:pos] + str(new_digit) + number[pos + 1 :]
                assert not verhoeff_valid(mutated), f"undetected single-digit change at {pos}"


def test_verhoeff_all_zero_base_round_trips() -> None:
    check = verhoeff_generate("0" * 11)
    assert verhoeff_valid("0" * 11 + check)


def test_luhn_round_trip_many_random_bases() -> None:
    rng = random.Random(11)
    for _ in range(200):
        base = "4" + "".join(str(rng.randint(0, 9)) for _ in range(14))  # Visa-shaped, 15+1=16
        check = luhn_generate(base)
        assert luhn_valid(base + check)
        assert len(base + check) == 16


def test_luhn_detects_every_single_digit_change() -> None:
    rng = random.Random(13)
    for _ in range(50):
        base = "4" + "".join(str(rng.randint(0, 9)) for _ in range(14))
        number = base + luhn_generate(base)
        for pos in range(16):
            for new_digit in range(10):
                if new_digit == int(number[pos]):
                    continue
                mutated = number[:pos] + str(new_digit) + number[pos + 1 :]
                assert not luhn_valid(mutated), f"undetected single-digit change at {pos}"


def test_luhn_known_vector() -> None:
    # Widely published Luhn test number.
    assert luhn_valid("4532015112830366")


def test_luhn_rejects_known_invalid_vector() -> None:
    assert not luhn_valid("4532015112830367")


def test_gstin_round_trip() -> None:
    prefix = "27AAPFU0939F1Z"
    check = gstin_generate(prefix)
    assert gstin_valid(prefix + check)


def test_gstin_detects_check_character_mutation() -> None:
    prefix = "29ABCDE1234F1Z"
    check = gstin_generate(prefix)
    charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for c in charset:
        if c == check:
            continue
        mutated = prefix + c
        assert not gstin_valid(mutated)


def test_gstin_wrong_length_is_invalid() -> None:
    assert not gstin_valid("27AAPFU0939F1Z")  # 14 chars, missing check

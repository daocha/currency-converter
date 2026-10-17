from app.history import combine


def test_usd_base_uses_quote_leg():
    assert combine({}, {1: 150.0, 2: 151.0}, "USD", "JPY", 86400) == [[86400, 150.0], [172800, 151.0]]


def test_usd_quote_inverts_base_leg():
    assert combine({1: 4.0}, {}, "PLN", "USD", 60) == [[60, 0.25]]


def test_cross_pair_uses_shared_buckets_only():
    pts = combine({1: 0.5, 2: 0.5, 3: 0.5}, {2: 1.0, 3: 2.0, 4: 9.0}, "EUR", "GBP", 10)
    assert pts == [[20, 2.0], [30, 4.0]]

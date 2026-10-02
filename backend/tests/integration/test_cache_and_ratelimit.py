import pytest
from redis.asyncio import Redis

from app.cache.redis_cache import Cache, CacheDomain, RateLimiter, get_redis

pytestmark = pytest.mark.integration


async def test_cache_hit_and_versioned_invalidation(db: None) -> None:
    cache = Cache(get_redis())
    calls = 0

    async def compute() -> dict:
        nonlocal calls
        calls += 1
        return {"n": calls}

    assert await cache.get_or_set("t", [CacheDomain.INVENTORY], compute) == {"n": 1}
    assert await cache.get_or_set("t", [CacheDomain.INVENTORY], compute) == {"n": 1}  # hit
    await cache.invalidate(CacheDomain.SALES)  # unrelated domain
    assert await cache.get_or_set("t", [CacheDomain.INVENTORY], compute) == {"n": 1}
    await cache.invalidate(CacheDomain.INVENTORY)
    assert await cache.get_or_set("t", [CacheDomain.INVENTORY], compute) == {"n": 2}  # recomputed
    assert await cache.get_or_set("t", [CacheDomain.INVENTORY], compute, params={"x": 1}) == {"n": 3}
    assert cache.hits == 2


async def test_cache_fails_open_when_redis_is_down(db: None) -> None:
    dead = Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)
    cache = Cache(dead)

    async def compute() -> int:
        return 42

    assert await cache.get_or_set("t", [CacheDomain.SALES], compute) == 42
    await cache.invalidate(CacheDomain.SALES)
    assert not await cache.ping()
    # circuit breaker open: subsequent calls skip Redis entirely
    assert not cache._available()
    assert await cache.get_or_set("t", [CacheDomain.SALES], compute) == 42


async def test_rate_limiter_blocks_after_limit_and_fails_open(db: None) -> None:
    limiter = RateLimiter(get_redis())
    results = [await limiter.hit("login:test", 3, 60) for _ in range(4)]
    assert [ok for ok, _ in results] == [True, True, True, False]
    assert results[-1][1] > 0
    await limiter.reset("login:test")
    assert (await limiter.hit("login:test", 3, 60))[0]
    dead = RateLimiter(Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2))
    assert (await dead.hit("x", 1, 60))[0]

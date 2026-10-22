"""Legal blackout guard (loi n° 77-808, art. 11): no new poll-based publication on the eve and day of each round.

Frozen from Friday 18:00 Paris time (overseas territories vote on Saturday) to Sunday 20:00, both rounds.
Prints `frozen=true|false`; the daily workflow appends it to $GITHUB_OUTPUT and skips build/deploy when true.
"""

import sys
from datetime import datetime
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")
WINDOWS = [
    (datetime(2027, 4, 16, 18, 0, tzinfo=PARIS), datetime(2027, 4, 18, 20, 0, tzinfo=PARIS)),
    (datetime(2027, 4, 30, 18, 0, tzinfo=PARIS), datetime(2027, 5, 2, 20, 0, tzinfo=PARIS)),
]


def frozen(now: datetime) -> bool:
    return any(start <= now < end for start, end in WINDOWS)


def demo() -> None:
    assert frozen(datetime(2027, 4, 17, 12, 0, tzinfo=PARIS))
    assert frozen(datetime(2027, 4, 16, 18, 0, tzinfo=PARIS))
    assert not frozen(datetime(2027, 4, 16, 17, 59, tzinfo=PARIS))
    assert not frozen(datetime(2027, 4, 18, 20, 0, tzinfo=PARIS))
    assert frozen(datetime(2027, 5, 1, 23, 0, tzinfo=PARIS))


if __name__ == "__main__":
    demo()
    now = (
        datetime.fromisoformat(sys.argv[1]).replace(tzinfo=PARIS)
        if len(sys.argv) > 1
        else datetime.now(PARIS)
    )
    print(f"frozen={'true' if frozen(now) else 'false'}")

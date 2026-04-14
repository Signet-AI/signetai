import sqlite3


def test_percent_metacharacter_escaped():
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE memories (id INTEGER PRIMARY KEY, tags TEXT)")
    db.execute(
        "INSERT INTO memories VALUES (1, 'work,urgent'), (2, 'personal'), (3, 'nodanger')"
    )
    search = "%"
    safe = search.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = db.execute(
        "SELECT tags FROM memories WHERE LOWER(tags) LIKE ? ESCAPE '\\'",
        (f"%{safe}%",),
    ).fetchall()
    assert len(rows) == 0, f"LIKE metacharacter not escaped: got {rows}"
    db.close()


def test_literal_match_still_works():
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE memories (id INTEGER PRIMARY KEY, tags TEXT)")
    db.execute(
        "INSERT INTO memories VALUES (1, 'work,urgent'), (2, 'personal'), (3, 'nodanger')"
    )
    search = "work"
    safe = search.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = db.execute(
        "SELECT tags FROM memories WHERE LOWER(tags) LIKE ? ESCAPE '\\'",
        (f"%{safe}%",),
    ).fetchall()
    assert len(rows) == 1 and rows[0][0] == "work,urgent"
    db.close()


def test_underscore_metacharacter_escaped():
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE memories (id INTEGER PRIMARY KEY, tags TEXT)")
    db.execute(
        "INSERT INTO memories VALUES (1, 'work,urgent'), (2, 'personal'), (3, 'nodanger')"
    )
    search = "_"
    safe = search.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = db.execute(
        "SELECT tags FROM memories WHERE LOWER(tags) LIKE ? ESCAPE '\\'",
        (f"%{safe}%",),
    ).fetchall()
    assert len(rows) == 0, f"underscore metacharacter not escaped: got {rows}"
    db.close()

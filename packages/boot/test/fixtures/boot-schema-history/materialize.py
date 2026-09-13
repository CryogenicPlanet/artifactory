"""Render an independently exported historical catalog as literal fixture SQL."""
import json
import pathlib
import sys

export = json.loads(pathlib.Path(sys.argv[1]).read_text())
version = export["version"]
assert version in (16, 18)
target = pathlib.Path(sys.argv[2])


def identifier(text):
    return '"' + text.replace('"', '""') + '"'


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + value.replace("'", "''") + "'"


statements = [
    f"-- Exported from the historical v{version} initializer. See README.md; do not regenerate from current code.",
    "PRAGMA auto_vacuum=INCREMENTAL;",
]
for kind in ("table", "index", "view", "trigger"):
    statements.extend(
        row["sql"] + ";"
        for row in export["catalog"]
        if row["type"] == kind and row["sql"] is not None and not row["name"].startswith("sqlite_")
    )
for table, rows in export["rows"].items():
    for row in rows:
        statements.append(
            f"INSERT INTO {identifier(table)}(" + ",".join(map(identifier, row))
            + ") VALUES(" + ",".join(map(literal, row.values())) + ");"
        )
statements.append(f"PRAGMA user_version={version};")
(target / f"v{version}.sql").write_text("\n\n".join(statements) + "\n")
(target / f"v{version}.catalog.json").write_text(json.dumps(export["catalog"], indent=2) + "\n")

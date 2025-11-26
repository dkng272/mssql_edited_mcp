# MSSQL MCP Server

A Model Context Protocol (MCP) server that enables AI assistants like Claude to interact with Microsoft SQL Server databases through natural language.

## Features

- **Natural Language Queries** - Ask questions in plain English, get SQL results
- **Full CRUD Operations** - Read, create, update, and delete data
- **Schema Management** - Create tables, indexes, and manage structure
- **Execute Python** - Server-side data processing with pandas/numpy (99% context reduction)
- **Export to CSV** - Export query results directly to files
- **Secure Connection** - Azure AD authentication support

## Quick Start

```bash
cd MssqlMcp/Node
npm install
pip install -r requirements.txt
npm run build
```

See [MssqlMcp/Node/README.md](MssqlMcp/Node/README.md) for full setup instructions.

## Execute Python Tool

Process large datasets server-side, return only summaries:

```python
df = query("""
    SELECT p.TICKER, p.PX_LAST, s.L2 as Sector
    FROM Market_Data p
    JOIN Sector_Map s ON p.TICKER = s.Ticker
    WHERE s.L2 = 'Brokerage'
""")

result = {
    "avg_price": df['PX_LAST'].mean(),
    "count": len(df)
}
```

45,000 rows → 127 bytes in context.

See [MssqlMcp/Node/docs/execute_python.md](MssqlMcp/Node/docs/execute_python.md) for full documentation.

## Project Structure

```
MssqlMcp/Node/
├── src/
│   ├── index.ts           # MCP server entry point
│   ├── tools/             # Tool implementations
│   │   ├── ExecutePythonTool.ts
│   │   ├── ReadDataTool.ts
│   │   ├── ExportDataTool.ts
│   │   └── ...
│   └── python/
│       └── sandbox_executor.py
├── docs/
│   └── execute_python.md
└── README.md
```

## License

MIT License - See [LICENSE](LICENSE)

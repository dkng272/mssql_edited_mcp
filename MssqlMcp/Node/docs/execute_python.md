# Execute Python Tool

A powerful MCP tool that enables Claude to write Python code for server-side SQL data processing, dramatically reducing context window usage by returning only processed summaries instead of raw data.

**Supports:** `SELECT` queries and `WITH` (Common Table Expressions/CTEs) for complex analytics.

## Why This Tool?

Traditional SQL tools return full query results to Claude's context:

```
Query: SELECT * FROM Sales WHERE Year = 2024
Result: 45,000 rows × 12 columns = ~2MB of JSON in context
```

With `execute_python`, Claude processes data server-side:

```python
df = query("SELECT * FROM Sales WHERE Year = 2024")
result = {"total": df['Revenue'].sum(), "by_region": df.groupby('Region')['Revenue'].sum().to_dict()}
```

```
Result: 247 bytes in context (99.99% reduction)
```

## How It Works

### Agent Writes Full Python Code

The AI agent writes complete Python code - not just JSON output. The agent has full control over:
- Which SQL queries to run via `query()`
- How to process data (pandas, numpy, sklearn, etc.)
- What to include in the final `result` variable

```python
# Agent writes this entire code block
df = query("SELECT Ticker, PX_LAST FROM Market_Data WHERE ...")

# Agent writes the processing logic
avg_price = df['PX_LAST'].mean()
top_5 = df.nlargest(5, 'PX_LAST')

# Agent must assign to 'result' - only this gets returned
result = {
    "average": avg_price,
    "top_5": top_5.to_dict('records')
}
```

### Execution Flow

```
┌─────────────────────────────────────────────────────────┐
│ 1. Agent writes full Python code                        │
│    (query + pandas processing + result assignment)      │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 2. MCP Tool receives code as string parameter           │
│    { "code": "df = query(...)\nresult = {...}" }       │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 3. Python sandbox executes code via exec()              │
│    - query() fetches SQL data → returns DataFrame       │
│    - pandas/numpy process the data                      │
│    - 'result' variable captured from namespace          │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 4. Only 'result' value returned to agent                │
│    (must be JSON-serializable: dict, list, numbers)     │
└─────────────────────────────────────────────────────────┘
```

### Two-Phase SQL Execution (Internal)

The tool uses a **two-phase execution** pattern to securely bridge Python and SQL:

```
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Query Collection                                           │
│ Python code runs → query() records SQL statements → returns empty   │
│ DataFrames → Tool collects list of SQL queries needed               │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 2: SQL Execution                                              │
│ Each collected query is validated (SELECT only, no injection) →     │
│ Executed via secure MSSQL connection → Results stored               │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Data Processing                                            │
│ Python code runs again → query() returns actual DataFrames →        │
│ Code processes/aggregates data → Only 'result' variable returned    │
└─────────────────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

- Python 3.9 or higher
- Node.js 18+ (for the MCP server)

### Install Python Dependencies

```bash
cd /path/to/MssqlMcp/Node
pip install -r requirements.txt
```

**Required packages:**
- pandas >= 2.0.0
- numpy >= 1.24.0
- scipy >= 1.11.0
- scikit-learn >= 1.3.0
- matplotlib >= 3.7.0

### Build the MCP Server

```bash
npm run build
```

## Usage

### Basic Example

```python
# Query and aggregate - only summary returns to context
df = query("SELECT Region, Revenue, ProductCategory FROM Sales WHERE Year = 2024")

result = {
    "total_revenue": df['Revenue'].sum(),
    "by_region": df.groupby('Region')['Revenue'].sum().to_dict(),
    "by_category": df.groupby('ProductCategory')['Revenue'].sum().to_dict(),
    "record_count": len(df)
}
```

### Statistical Analysis

```python
df = query("SELECT Price, Volume, MarketCap FROM Stocks WHERE Date >= '2024-01-01'")

result = {
    "correlation_matrix": df.corr().to_dict(),
    "price_stats": df['Price'].describe().to_dict(),
    "volume_percentiles": {
        "p25": df['Volume'].quantile(0.25),
        "p50": df['Volume'].quantile(0.50),
        "p75": df['Volume'].quantile(0.75),
        "p99": df['Volume'].quantile(0.99)
    }
}
```

### Related Data with SQL JOINs (Recommended)

**Use SQL JOINs** when you need data from multiple related tables. This is more reliable than multiple queries because the two-phase execution handles JOINs in a single pass.

```python
# RECOMMENDED: Use SQL JOIN for related data
df = query("""
    SELECT
        p.TICKER, p.TRADE_DATE, p.PX_LAST,
        s.L2 as Sector, s.L3 as SubSector
    FROM Market_Data p
    JOIN Sector_Map s ON p.TICKER = s.Ticker
    WHERE s.L2 = 'Brokerage'
    ORDER BY p.TICKER, p.TRADE_DATE
""")

# Process with pandas
results = []
for ticker in df['TICKER'].unique():
    stock = df[df['TICKER'] == ticker]
    high_50d = stock['PX_LAST'].rolling(50).max()
    current = stock['PX_LAST'].iloc[-1]
    drawdown = (current / high_50d.iloc[-1] - 1) * 100
    results.append({
        'ticker': ticker,
        'sector': stock['SubSector'].iloc[0],
        'current_price': current,
        'drawdown_pct': round(drawdown, 2)
    })

result = {'drawdowns': results}
```

### Multiple Independent Queries

For unrelated tables that don't need JOINs, multiple `query()` calls work fine:

```python
sales = query("SELECT ProductID, Revenue, Quantity FROM Sales WHERE Year = 2024")
products = query("SELECT ProductID, ProductName, Category FROM Products")

# Merge in Python
merged = sales.merge(products, on='ProductID')

result = {
    "top_products": merged.groupby('ProductName')['Revenue'].sum().nlargest(10).to_dict(),
    "category_breakdown": merged.groupby('Category').agg({
        'Revenue': 'sum',
        'Quantity': 'sum'
    }).to_dict()
}
```

### Avoid: Dynamic SQL with Query Results

**Don't** build SQL queries using results from previous queries (f-strings). This fails because the first query returns empty during dry run.

```python
# WRONG - This will fail!
tickers_df = query("SELECT Ticker FROM Sector_Map WHERE L2 = 'Banks'")
ticker_list = "','".join(tickers_df['Ticker'].tolist())
prices = query(f"SELECT * FROM Market_Data WHERE TICKER IN ('{ticker_list}')")

# CORRECT - Use SQL JOIN instead (see above)
```

### Time Series Analysis

```python
df = query("""
    SELECT TradingDate, ClosePrice, Volume
    FROM StockPrices
    WHERE Ticker = 'VNM' AND TradingDate >= '2024-01-01'
    ORDER BY TradingDate
""")

df['TradingDate'] = pd.to_datetime(df['TradingDate'])
df['Returns'] = df['ClosePrice'].pct_change()
df['MA20'] = df['ClosePrice'].rolling(20).mean()

result = {
    "current_price": df['ClosePrice'].iloc[-1],
    "ma20": df['MA20'].iloc[-1],
    "ytd_return": (df['ClosePrice'].iloc[-1] / df['ClosePrice'].iloc[0] - 1) * 100,
    "volatility": df['Returns'].std() * np.sqrt(252) * 100,  # Annualized
    "avg_volume": df['Volume'].mean(),
    "max_drawdown": ((df['ClosePrice'] / df['ClosePrice'].cummax()) - 1).min() * 100
}
```

### Machine Learning: Clustering

```python
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import KMeans

df = query("SELECT Ticker, ROE, PER, PBR, DebtToEquity FROM FinancialMetrics WHERE Year = 2024")

# Prepare features
features = df[['ROE', 'PER', 'PBR', 'DebtToEquity']].dropna()
scaler = StandardScaler()
scaled = scaler.fit_transform(features)

# Cluster stocks
kmeans = KMeans(n_clusters=4, random_state=42)
df_clean = df.dropna(subset=['ROE', 'PER', 'PBR', 'DebtToEquity']).copy()
df_clean['Cluster'] = kmeans.fit_predict(scaled)

result = {
    "clusters": df_clean.groupby('Cluster')['Ticker'].apply(list).to_dict(),
    "cluster_centers": {
        f"cluster_{i}": dict(zip(['ROE', 'PER', 'PBR', 'DebtToEquity'], center))
        for i, center in enumerate(scaler.inverse_transform(kmeans.cluster_centers_))
    }
}
```

### Complex Analytics with CTEs

```python
# Common Table Expressions (WITH) are fully supported
df = query("""
    WITH MonthlyRevenue AS (
        SELECT
            FORMAT(OrderDate, 'yyyy-MM') as Month,
            SUM(Revenue) as Revenue,
            COUNT(*) as Orders
        FROM Sales
        WHERE OrderDate >= '2024-01-01'
        GROUP BY FORMAT(OrderDate, 'yyyy-MM')
    ),
    GrowthCalc AS (
        SELECT
            Month,
            Revenue,
            Orders,
            LAG(Revenue) OVER (ORDER BY Month) as PrevRevenue
        FROM MonthlyRevenue
    )
    SELECT
        Month,
        Revenue,
        Orders,
        CASE WHEN PrevRevenue > 0
             THEN (Revenue - PrevRevenue) * 100.0 / PrevRevenue
             ELSE 0 END as GrowthPct
    FROM GrowthCalc
    ORDER BY Month
""")

result = {
    "monthly_data": df.to_dict('records'),
    "total_revenue": df['Revenue'].sum(),
    "avg_growth": df['GrowthPct'].mean(),
    "best_month": df.loc[df['Revenue'].idxmax(), 'Month']
}
```

### Chart Generation

```python
df = query("SELECT Quarter, Revenue FROM QuarterlySales WHERE Year >= 2022 ORDER BY Quarter")

plt.figure(figsize=(10, 6))
plt.bar(df['Quarter'], df['Revenue'])
plt.title('Quarterly Revenue Trend')
plt.xlabel('Quarter')
plt.ylabel('Revenue (VND)')
plt.xticks(rotation=45)

result = {
    "chart": save_plot(),  # Returns base64-encoded PNG
    "data_summary": {
        "quarters": len(df),
        "total_revenue": df['Revenue'].sum(),
        "growth": (df['Revenue'].iloc[-1] / df['Revenue'].iloc[0] - 1) * 100
    }
}
```

## Available Functions & Packages

### Core Functions

| Function | Description |
|----------|-------------|
| `query(sql)` | Execute SQL query (SELECT or WITH/CTE), returns pandas DataFrame |
| `save_plot()` | Save current matplotlib figure as base64 PNG string |

> **Note:** Both `SELECT` and `WITH` (Common Table Expressions) queries are supported. CTEs are powerful for complex analytics.

### Pre-imported Packages

| Package | Import As | Common Uses |
|---------|-----------|-------------|
| pandas | `pd` | DataFrames, groupby, merge, pivot tables |
| numpy | `np` | Numerical operations, statistics |
| scipy | `scipy`, `stats` | Statistical tests, distributions |
| scikit-learn | `sklearn` | Preprocessing, clustering, decomposition |
| matplotlib | `plt` | Charts and visualizations |

### sklearn Submodules Available

```python
sklearn['preprocessing']   # StandardScaler, MinMaxScaler, LabelEncoder
sklearn['cluster']         # KMeans, DBSCAN, AgglomerativeClustering
sklearn['decomposition']   # PCA, TruncatedSVD
sklearn['metrics']         # silhouette_score, pairwise_distances
```

### Safe Builtins

```python
# Math: sum, min, max, abs, round, pow, divmod
# Types: list, dict, set, tuple, str, int, float, bool, bytes
# Iteration: range, enumerate, zip, map, filter, sorted, reversed, all, any
# Type checking: isinstance, type, callable, hasattr
# String: format, repr, chr, ord
# Output: print (captured to stdout)
```

## Input Schema

```json
{
  "code": "string (required) - Python code to execute",
  "timeout": "number (optional) - Max seconds, default 30, max 120",
  "maxOutputSize": "number (optional) - Max result bytes, default 100000"
}
```

## Response Format

### Success

```json
{
  "success": true,
  "result": { "your": "processed data" },
  "stdout": "any print() output",
  "queries_executed": ["SELECT ...", "SELECT ..."],
  "result_size_bytes": 1234
}
```

### Errors

Errors include actionable hints to help AI agents self-correct:

```json
{
  "success": false,
  "error": "SQL_EXECUTION_FAILED",
  "message": "Query 1 failed: Invalid column name 'TICKER'",
  "query": "SELECT TICKER FROM Market_Data WHERE...",
  "hint": "Column may not exist or check casing (SQL Server is case-sensitive for some collations)"
}
```

```json
{
  "success": false,
  "error": "PYTHON_ERROR",
  "message": "KeyError: 'TICKER'",
  "available_columns": {
    "df": ["Ticker", "TRADE_DATE", "PX_LAST", "Volume"]
  },
  "hint": "Column not found - check column name casing. Use df.columns.tolist() to see available columns"
}
```

**Error Codes:**

| Code | Description | Common Hints |
|------|-------------|--------------|
| `CODE_VALIDATION_FAILED` | Dangerous Python pattern detected | Remove blocked imports/functions |
| `SQL_VALIDATION_FAILED` | SQL query failed security checks | Use SELECT/WITH only |
| `SQL_EXECUTION_FAILED` | Database query error | Check table/column names, casing |
| `PYTHON_ERROR` | Runtime error in Python code | Check column casing, DataFrame emptiness |
| `OUTPUT_TOO_LARGE` | Result exceeds maxOutputSize | Add aggregations or filters |
| `TIMEOUT` | Execution exceeded time limit | Optimize queries, increase timeout |

### Warnings

Successful responses may include warnings:

```json
{
  "success": true,
  "result": { ... },
  "warning": "Query 1 returned 0 rows - check filter conditions"
}
```

## Security

### Multi-Layer Protection

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Python Code Validation                             │
│ Blocks: os, subprocess, sys, open(), exec(), eval(),        │
│         __import__, getattr, setattr, socket, requests...   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Restricted Python Namespace                        │
│ Only safe builtins available, no file/network access        │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: SQL Query Validation                               │
│ SELECT or WITH (CTE) only, blocks DROP/DELETE/UPDATE/INSERT │
│ /EXEC, no multiple statements, injection pattern detection  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 4: Subprocess Isolation                               │
│ Timeout limits, minimal environment variables               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 5: Output Size Limits                                 │
│ maxOutputSize parameter prevents context flooding           │
└─────────────────────────────────────────────────────────────┘
```

### Blocked Patterns

**Python (examples):**
- `import os`, `import subprocess`, `import sys`
- `open()`, `exec()`, `eval()`, `__import__()`
- `getattr()`, `setattr()`, `globals()`, `locals()`

**SQL (examples):**
- `DELETE`, `DROP`, `UPDATE`, `INSERT`, `ALTER`
- `EXEC`, `EXECUTE`, stored procedures (`sp_`, `xp_`)
- Multiple statements (`;` followed by commands)
- `OPENROWSET`, `BULK INSERT`, `WAITFOR`

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PYTHON_PATH` | `python3` | Path to Python executable |

### Adjusting Limits

In tool call:
```json
{
  "code": "...",
  "timeout": 60,
  "maxOutputSize": 200000
}
```

## Best Practices

### Do: Aggregate Before Returning

```python
# Good - returns small summary
df = query("SELECT * FROM LargeTable")
result = {
    "count": len(df),
    "sum": df['Value'].sum(),
    "top_10": df.nlargest(10, 'Value').to_dict('records')
}
```

### Don't: Return Raw DataFrames

```python
# Bad - returns all data
df = query("SELECT * FROM LargeTable")
result = df.to_dict('records')  # Could be huge!
```

### Do: Use SQL for Initial Filtering (CTEs are great for this!)

```python
# Good - filter and pre-aggregate in SQL with CTE
df = query("""
    WITH FilteredSales AS (
        SELECT Product, Revenue
        FROM Sales
        WHERE Year = 2024 AND Region = 'North'
    )
    SELECT Product, SUM(Revenue) as TotalRevenue
    FROM FilteredSales
    GROUP BY Product
""")
result = df.set_index('Product')['TotalRevenue'].to_dict()
```

### Don't: Fetch Everything Then Filter

```python
# Bad - fetches all data
df = query("SELECT * FROM Sales")
filtered = df[(df['Year'] == 2024) & (df['Region'] == 'North')]
```

## Troubleshooting

### "Failed to spawn Python process"

Ensure Python 3 is installed and in PATH:
```bash
python3 --version
which python3
```

Or set custom path:
```bash
export PYTHON_PATH=/usr/local/bin/python3.11
```

### "Module not found" errors

Install required packages:
```bash
pip install -r requirements.txt
```

### "OUTPUT_TOO_LARGE" error

Aggregate more aggressively:
```python
# Instead of returning all records
result = df.head(100).to_dict('records')

# Return summary statistics
result = {
    "stats": df.describe().to_dict(),
    "sample": df.head(5).to_dict('records')
}
```

### Timeout errors

- Increase timeout parameter (max 120s)
- Optimize SQL queries with proper indexes
- Process data in chunks if needed

## Comparison: Before vs After

| Metric | Traditional read_data | execute_python |
|--------|----------------------|----------------|
| Context usage | Full query results | Processed summary only |
| 45K rows query | ~2MB in context | ~200 bytes in context |
| Processing | Claude reasons over raw data | Server-side Python |
| Aggregations | Multiple tool calls | Single tool call |
| Visualizations | Not possible | Built-in matplotlib |

## Version History

- **1.0.0** (2024-11) - Initial release
  - Two-phase SQL execution
  - pandas, numpy, scipy, sklearn, matplotlib support
  - Multi-layer security validation
  - Chart generation with save_plot()

# MSSQL Database MCP  Server

<div align="center">
  <img src="./src/img/logo.png" alt="MSSQL Database MCP server logo" width="400"/>
</div>

> ⚠️ **EXPERIMENTAL USE ONLY** - This MCP Server is provided as an example for educational and experimental purposes only. It is NOT intended for production use. Please use appropriate security measures and thoroughly test before considering any kind of deployment.

## What is this? 🤔

This is a server that lets your LLMs (like Claude) talk directly to your MSSQL Database data! Think of it as a friendly translator that sits between your AI assistant and your database, making sure they can chat securely and efficiently.

### Quick Example
```text
You: "Show me all customers from New York"
Claude: *queries your MSSQL Database database and gives you the answer in plain English*
```

## How Does It Work? 🛠️

This server leverages the Model Context Protocol (MCP), a versatile framework that acts as a universal translator between AI models and databases. It supports multiple AI assistants including Claude Desktop and VS Code Agent.

### What Can It Do? 📊

- Run MSSQL Database queries by just asking questions in plain English
- Create, read, update, and delete data
- Manage database schema (tables, indexes)
- Secure connection handling
- Real-time data interaction
- **Execute Python code** for server-side data processing (see below)

## Execute Python Tool 🐍

A powerful feature that lets AI agents write Python code to process SQL data server-side, dramatically reducing context window usage.

### The Problem
Traditional SQL tools return full query results to context:
```
Query: SELECT * FROM Sales WHERE Year = 2024
Result: 45,000 rows × 12 columns = ~2MB in context 😱
```

### The Solution
With `execute_python`, the agent writes Python code that runs on the server:

```python
# Agent writes this complete code block
df = query("""
    SELECT p.TICKER, p.PX_LAST, s.L2 as Sector
    FROM Market_Data p
    JOIN Sector_Map s ON p.TICKER = s.Ticker
    WHERE s.L2 = 'Brokerage'
""")

# Process with pandas
avg_by_sector = df.groupby('Sector')['PX_LAST'].mean()

# Only 'result' is returned to context
result = {
    "average_price": avg_by_sector.to_dict(),
    "total_stocks": len(df)
}
```

```
Result: 127 bytes in context ✅ (99.99% reduction)
```

### How It Works

```
┌─────────────────────────────────────────────────────────┐
│ 1. Agent writes full Python code                        │
│    (SQL queries + pandas processing + result)           │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 2. Tool executes in sandboxed Python environment        │
│    - query() fetches SQL data → DataFrame               │
│    - pandas/numpy/sklearn process data                  │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 3. Only 'result' variable returned to agent             │
│    (must be JSON-serializable)                          │
└─────────────────────────────────────────────────────────┘
```

### Available Packages
- **pandas** (`pd`) - DataFrames, groupby, merge
- **numpy** (`np`) - Numerical operations
- **scipy** (`stats`) - Statistical functions
- **scikit-learn** (`sklearn`) - ML preprocessing, clustering
- **matplotlib** (`plt`) - Charts via `save_plot()`

### Requirements
```bash
pip install pandas numpy scipy scikit-learn matplotlib
```

📖 **Full documentation:** [docs/execute_python.md](docs/execute_python.md)

## Quick Start 🚀

### Prerequisites
- Node.js 18 or higher
- Python 3.9+ (for execute_python tool)
- Claude Desktop or VS Code with Agent extension

### Set up project

1. **Install Node Dependencies**
   ```bash
   npm install
   ```

2. **Install Python Dependencies** (for execute_python tool)
   ```bash
   pip install -r requirements.txt
   ```

3. **Build the Project**
   ```bash
   npm run build
   ```

## Configuration Setup

### Option 1: VS Code Agent Setup

1. **Install VS Code Agent Extension**
   - Open VS Code
   - Go to Extensions (Ctrl+Shift+X)
   - Search for "Agent" and install the official Agent extension

2. **Create MCP Configuration File**
   - Create a `.vscode/mcp.json` file in your workspace
   - Add the following configuration:

   ```json
   {
     "servers": {
       "mssql-nodejs": {
          "type": "stdio",
          "command": "node",
          "args": ["q:\\Repos\\SQL-AI-samples\\MssqlMcp\\Node\\dist\\index.js"],
          "env": {
            "SERVER_NAME": "your-server-name.database.windows.net",
            "DATABASE_NAME": "your-database-name",
            "READONLY": "false",
            "PYTHON_PATH": "C:/Python311/python.exe"
          }
        }
      }
   }
   ```

3. **Alternative: User Settings Configuration**
   - Open VS Code Settings (Ctrl+,)
   - Search for "mcp"
   - Click "Edit in settings.json"
   - Add the following configuration:

  ```json
   {
    "mcp": {
        "servers": {
            "mssql": {
                "command": "node",
                "args": ["C:/path/to/your/Node/dist/index.js"],
                "env": {
                "SERVER_NAME": "your-server-name.database.windows.net",
                "DATABASE_NAME": "your-database-name",
                "READONLY": "false",
                "PYTHON_PATH": "C:/Python311/python.exe"
                }
            }
        }
    }
  }
  ```

4. **Restart VS Code**
   - Close and reopen VS Code for the changes to take effect

5. **Verify MCP Server**
   - Open Command Palette (Ctrl+Shift+P)
   - Run "MCP: List Servers" to verify your server is configured
   - You should see "mssql" in the list of available servers

### Option 2: Claude Desktop Setup

1. **Open Claude Desktop Settings**
   - Navigate to File → Settings → Developer → Edit Config
   - Open the `claude_desktop_config` file

2. **Add MCP Server Configuration**
   Replace the content with the configuration below, updating the path and credentials:

   ```json
   {
     "mcpServers": {
       "mssql": {
         "command": "node",
         "args": ["C:/path/to/your/Node/dist/index.js"],
         "env": {
           "SERVER_NAME": "your-server-name.database.windows.net",
           "DATABASE_NAME": "your-database-name",
           "READONLY": "false",
           "PYTHON_PATH": "/path/to/python3"
         }
       }
     }
   }
   ```

   > **Note for execute_python users**: The `PYTHON_PATH` environment variable is required for the execute_python tool. Set it to your Python interpreter that has pandas, numpy, scipy, and scikit-learn installed (e.g., `/opt/anaconda3/bin/python3` on macOS, `C:/Python311/python.exe` on Windows).

3. **Restart Claude Desktop**
   - Close and reopen Claude Desktop for the changes to take effect

### Configuration Parameters

- **SERVER_NAME**: Your MSSQL Database server name (e.g., `my-server.database.windows.net`)
- **DATABASE_NAME**: Your database name
- **READONLY**: Set to `"true"` to restrict to read-only operations, `"false"` for full access
- **Path**: Update the path in `args` to point to your actual project location.
- **CONNECTION_TIMEOUT**: (Optional) Connection timeout in seconds. Defaults to `30` if not set.
- **TRUST_SERVER_CERTIFICATE**: (Optional) Set to `"true"` to trust self-signed server certificates (useful for development or when connecting to servers with self-signed certs). Defaults to `"false"`.
- **PYTHON_PATH**: (Required for execute_python) Full path to Python interpreter with required packages installed. Claude Desktop and VS Code may use different Python environments than your terminal, so specify the exact path (e.g., `/opt/anaconda3/bin/python3`, `C:/Python311/python.exe`).

## Sample Configurations

You can find sample configuration files in the `src/samples/` folder:
- `claude_desktop_config.json` - For Claude Desktop
- `vscode_agent_config.json` - For VS Code Agent

## Usage Examples

Once configured, you can interact with your database using natural language:

- "Show me all users from New York"
- "Create a new table called products with columns for id, name, and price"
- "Update all pending orders to completed status"
- "List all tables in the database"

## Security Notes

- The server requires a WHERE clause for read operations to prevent accidental full table scans
- Update operations require explicit WHERE clauses for security
- Set `READONLY: "true"` in environments if you only need read access

You should now have successfully configured the MCP server for MSSQL Database with your preferred AI assistant. This setup allows you to seamlessly interact with MSSQL Database through natural language queries!

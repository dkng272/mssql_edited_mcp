# SQL-AI-samples (Modified Fork)

## About this fork

This is a modified fork of the [Azure-Samples/SQL-AI-samples](https://github.com/Azure-Samples/SQL-AI-samples) repository with custom enhancements.

### Enhancements Added

**MSSQL MCP Server - Node.js Edition**
- **ExportDataTool**: New functionality to export SQL query results directly to CSV files
  - Executes SELECT queries and writes results to specified file paths
  - More efficient than read_data for large datasets
  - Includes optional header configuration
  - Available in both readonly and full access modes (safe read-only operation)
  - See: `MssqlMcp/Node/src/tools/ExportDataTool.ts`

- **Schema-based Table Access Control**: Enhanced ListTableTool with schema filtering
  - Filter and list tables from specific database schemas
  - Allows restricting access to specific schemas for better security and organization
  - Supports multiple schema filtering in a single query
  - See: `MssqlMcp/Node/src/tools/ListTableTool.ts`


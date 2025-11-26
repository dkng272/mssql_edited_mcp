import { spawn } from "child_process";
import sql from "mssql";
import * as path from "path";
import { fileURLToPath } from "url";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PythonResult {
  success: boolean;
  result?: any;
  error?: string;
  line_number?: number;
  hint?: string;
  stdout?: string;
  stderr?: string;
  queries_executed?: string[];
  available_columns?: Record<string, string[]>;
  available_packages?: string[];
}

interface SqlValidation {
  isValid: boolean;
  error?: string;
}

export class ExecutePythonTool implements Tool {
  [key: string]: any;
  name = "execute_python";
  description = `Execute Python code for SQL data analysis. Reduces context usage by processing data server-side.

Available:
- query(sql): Execute SQL SELECT query, returns pandas DataFrame
- pd (pandas), np (numpy), scipy, sklearn, plt (matplotlib) pre-imported
- save_plot(): Save current matplotlib figure as base64 PNG

Usage:
- Assign final result to 'result' variable
- Result must be JSON-serializable (dict, list, numbers, strings)
- Use for aggregations, filtering, statistics to reduce data returned

IMPORTANT - Use JOINs for related data:
  # Get sector stocks with price data in ONE query:
  df = query("""
      SELECT p.TICKER, p.TRADE_DATE, p.PX_LAST, s.L3 as Tier
      FROM Market_Data p
      JOIN Sector_Map s ON p.TICKER = s.Ticker
      WHERE s.L2 = 'Brokerage'
      ORDER BY p.TICKER, p.TRADE_DATE
  """)

  # Then process with pandas:
  for ticker in df['TICKER'].unique():
      stock = df[df['TICKER'] == ticker]
      high_50d = stock['PX_LAST'].rolling(50).max()
      # ... calculations

  # WRONG - dynamic SQL fails in dry run:
  tickers = query("SELECT Ticker FROM Sector_Map WHERE L2='Banks'")
  prices = query(f"SELECT * FROM Market_Data WHERE TICKER IN ({tickers})")

Example:
  df = query("SELECT Region, Revenue FROM Sales WHERE Year = 2024")
  result = {
      "total": df['Revenue'].sum(),
      "by_region": df.groupby('Region')['Revenue'].sum().to_dict()
  }`;

  inputSchema = {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "Python code to execute. Must assign result to 'result' variable.",
      },
      timeout: {
        type: "number",
        description: "Max execution time in seconds (default: 30, max: 120)",
        default: 30,
      },
      maxOutputSize: {
        type: "number",
        description: "Max result size in bytes (default: 100000)",
        default: 100000,
      },
    },
    required: ["code"],
  } as any;

  // Dangerous Python patterns to block
  private static readonly DANGEROUS_CODE_PATTERNS = [
    /import\s+os\b/i,
    /import\s+subprocess\b/i,
    /import\s+sys\b/i,
    /import\s+shutil\b/i,
    /import\s+socket\b/i,
    /import\s+requests\b/i,
    /import\s+urllib\b/i,
    /import\s+http\b/i,
    /import\s+ftplib\b/i,
    /import\s+smtplib\b/i,
    /import\s+pickle\b/i,
    /import\s+marshal\b/i,
    /import\s+ctypes\b/i,
    /import\s+multiprocessing\b/i,
    /import\s+threading\b/i,
    /from\s+os\s+import/i,
    /from\s+subprocess\s+import/i,
    /from\s+sys\s+import/i,
    /__import__\s*\(/i,
    /exec\s*\(/i,
    /eval\s*\(/i,
    /compile\s*\(/i,
    /open\s*\(/i,
    /file\s*\(/i,
    /input\s*\(/i,
    /globals\s*\(/i,
    /locals\s*\(/i,
    /vars\s*\(/i,
    /dir\s*\(/i,
    /getattr\s*\(/i,
    /setattr\s*\(/i,
    /delattr\s*\(/i,
    /breakpoint\s*\(/i,
    /exit\s*\(/i,
    /quit\s*\(/i,
  ];

  // SQL validation (reused from ReadDataTool)
  private static readonly DANGEROUS_SQL_KEYWORDS = [
    'DELETE', 'DROP', 'UPDATE', 'INSERT', 'ALTER', 'CREATE',
    'TRUNCATE', 'EXEC', 'EXECUTE', 'MERGE', 'REPLACE',
    'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK', 'TRANSACTION',
    'BEGIN', 'DECLARE', 'SET', 'USE', 'BACKUP',
    'RESTORE', 'KILL', 'SHUTDOWN', 'WAITFOR', 'OPENROWSET',
    'OPENDATASOURCE', 'OPENQUERY', 'OPENXML', 'BULK', 'INTO'
  ];

  private static readonly DANGEROUS_SQL_PATTERNS = [
    /SELECT\s+.*?\s+INTO\s+/i,
    /;\s*(DELETE|DROP|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|MERGE|REPLACE|GRANT|REVOKE)/i,
    /UNION\s+(?:ALL\s+)?SELECT.*?(DELETE|DROP|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE)/i,
    /--.*?(DELETE|DROP|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE)/i,
    /\/\*.*?(DELETE|DROP|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE).*?\*\//i,
    /EXEC\s*\(/i,
    /EXECUTE\s*\(/i,
    /sp_/i,
    /xp_/i,
    /BULK\s+INSERT/i,
    /OPENROWSET/i,
    /OPENDATASOURCE/i,
    /WAITFOR\s+DELAY/i,
    /WAITFOR\s+TIME/i,
    /;\s*\w/,
    /\+\s*CHAR\s*\(/i,
    /\+\s*NCHAR\s*\(/i,
  ];

  /**
   * Generate hint for SQL errors to help AI agent self-correct
   */
  private getSqlErrorHint(errorMsg: string, query: string): string {
    const hints: string[] = [];

    // Common SQL Server error patterns
    if (errorMsg.includes('Invalid object name')) {
      hints.push('Table may not exist or check schema prefix (e.g., dbo.TableName)');
    }
    if (errorMsg.includes('Invalid column name')) {
      hints.push('Column may not exist or check casing (SQL Server is case-sensitive for some collations)');
    }
    if (errorMsg.includes('Conversion failed')) {
      hints.push('Data type mismatch - check column types match the values being compared');
    }
    if (errorMsg.includes('Arithmetic overflow')) {
      hints.push('Value too large for data type - consider using CAST or larger data type');
    }
    if (errorMsg.includes('Ambiguous column name')) {
      hints.push('Use table alias prefix (e.g., p.TICKER instead of TICKER)');
    }
    if (errorMsg.includes('syntax')) {
      hints.push('Check SQL syntax - common issues: missing commas, unclosed quotes, wrong JOIN syntax');
    }

    return hints.length > 0 ? hints.join('. ') : 'Check table/column names and SQL syntax';
  }

  /**
   * Generate hint for Python errors to help AI agent self-correct
   */
  private getPythonErrorHint(errorMsg: string): string {
    const hints: string[] = [];

    if (errorMsg.includes('ModuleNotFoundError')) {
      hints.push('Package not available in sandbox - available packages: pandas, numpy, scipy, sklearn');
      hints.push('These packages are pre-imported as: pd, np, scipy, sklearn (no import needed)');
    }
    if (errorMsg.includes('ImportError')) {
      hints.push('Import not allowed - available packages: pandas, numpy, scipy, sklearn');
      hints.push('Note: Packages are already pre-imported, no import statements needed');
    }
    if (errorMsg.includes('KeyError')) {
      hints.push('Column not found - check column name casing (SQL Server returns exact casing from schema)');
      hints.push('Use df.columns.tolist() to see available columns');
    }
    if (errorMsg.includes('TypeError') && errorMsg.includes('NoneType')) {
      hints.push('Variable is None - query may have returned empty DataFrame');
    }
    if (errorMsg.includes('IndexError')) {
      hints.push('Index out of range - DataFrame may be empty or smaller than expected');
    }
    if (errorMsg.includes('AttributeError')) {
      hints.push('Method/attribute not found - check pandas DataFrame vs Series usage');
    }
    if (errorMsg.includes('NameError')) {
      hints.push('Variable not defined - check variable names and ensure query() was called');
    }
    if (errorMsg.includes('empty')) {
      hints.push('DataFrame may be empty - check SQL filter conditions');
    }

    return hints.length > 0 ? hints.join('. ') : '';
  }

  /**
   * Validates Python code for dangerous patterns
   */
  private validateCode(code: string): { isValid: boolean; error?: string } {
    if (!code || typeof code !== 'string') {
      return { isValid: false, error: 'Code must be a non-empty string' };
    }

    if (code.length > 50000) {
      return { isValid: false, error: 'Code exceeds maximum length (50KB)' };
    }

    for (const pattern of ExecutePythonTool.DANGEROUS_CODE_PATTERNS) {
      if (pattern.test(code)) {
        return {
          isValid: false,
          error: `Blocked: dangerous pattern detected (${pattern.source.substring(0, 30)}...)`
        };
      }
    }

    return { isValid: true };
  }

  /**
   * Validates SQL query (reused logic from ReadDataTool)
   */
  private validateSqlQuery(query: string): SqlValidation {
    if (!query || typeof query !== 'string') {
      return { isValid: false, error: 'Query must be a non-empty string' };
    }

    const cleanQuery = query
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanQuery) {
      return { isValid: false, error: 'Query cannot be empty' };
    }

    const upperQuery = cleanQuery.toUpperCase();

    if (!upperQuery.startsWith('SELECT') && !upperQuery.startsWith('WITH')) {
      return { isValid: false, error: 'Query must start with SELECT or WITH' };
    }

    for (const keyword of ExecutePythonTool.DANGEROUS_SQL_KEYWORDS) {
      const keywordRegex = new RegExp(`(^|\\s|[^A-Za-z0-9_])${keyword}($|\\s|[^A-Za-z0-9_])`, 'i');
      if (keywordRegex.test(upperQuery)) {
        return { isValid: false, error: `Dangerous keyword '${keyword}' detected` };
      }
    }

    for (const pattern of ExecutePythonTool.DANGEROUS_SQL_PATTERNS) {
      if (pattern.test(query)) {
        return { isValid: false, error: 'Potentially malicious SQL pattern detected' };
      }
    }

    const statements = cleanQuery.split(';').filter(stmt => stmt.trim().length > 0);
    if (statements.length > 1) {
      return { isValid: false, error: 'Multiple SQL statements not allowed' };
    }

    if (query.length > 10000) {
      return { isValid: false, error: 'Query exceeds maximum length (10KB)' };
    }

    return { isValid: true };
  }

  /**
   * Execute Python code in sandbox subprocess
   */
  private executePython(
    code: string,
    queryData: Record<number, any[]>,
    timeout: number,
    isDryRun: boolean
  ): Promise<PythonResult> {
    return new Promise((resolve) => {
      const pythonPath = process.env.PYTHON_PATH || 'python3';
      const scriptPath = path.join(__dirname, '../python/sandbox_executor.py');

      const child = spawn(pythonPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: (timeout + 10) * 1000, // Buffer for Python startup
        env: {
          PATH: process.env.PATH,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUNBUFFERED: '1',
          HOME: process.env.HOME,
        }
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (exitCode) => {
        try {
          if (stdout) {
            const result = JSON.parse(stdout);
            resolve(result);
          } else {
            resolve({
              success: false,
              error: `Python process exited with code ${exitCode}${stderr ? ': ' + stderr.substring(0, 500) : ''}`
            });
          }
        } catch {
          resolve({
            success: false,
            error: `Failed to parse Python output: ${stdout.substring(0, 200)}`,
            stderr: stderr.substring(0, 500)
          });
        }
      });

      child.on('error', (err) => {
        resolve({
          success: false,
          error: `Failed to spawn Python process: ${err.message}. Ensure Python 3 is installed with pandas, numpy, scipy, sklearn, matplotlib.`
        });
      });

      // Send input to Python
      const input = JSON.stringify({
        code,
        query_data: queryData,
        timeout,
        is_dry_run: isDryRun
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }

  /**
   * Main execution logic with two-phase query handling
   */
  async run(params: any): Promise<any> {
    const { code, timeout = 30, maxOutputSize = 100000 } = params;

    // Validate Python code
    const codeValidation = this.validateCode(code);
    if (!codeValidation.isValid) {
      return {
        success: false,
        error: 'CODE_VALIDATION_FAILED',
        message: codeValidation.error
      };
    }

    const safeTimeout = Math.min(Math.max(timeout, 5), 120);

    try {
      // Phase 1: Dry run to collect SQL queries
      console.log('ExecutePython: Phase 1 - Collecting SQL queries...');
      const dryRunResult = await this.executePython(code, {}, safeTimeout, true);

      if (!dryRunResult.success && !dryRunResult.queries_executed?.length) {
        // If dry run failed and no queries collected, it's a code error
        const tsHint = this.getPythonErrorHint(dryRunResult.error || '');
        const fallbackHint = 'Dry run failed - check for syntax errors or ensure no dynamic SQL (f-strings with query results)';
        return {
          success: false,
          error: 'PYTHON_ERROR',
          message: dryRunResult.error,
          line_number: dryRunResult.line_number,
          hint: dryRunResult.hint || tsHint || fallbackHint,  // Prioritize Python hint, then TS hint, then fallback
          stdout: dryRunResult.stdout,
          stderr: dryRunResult.stderr
        };
      }

      const queries = dryRunResult.queries_executed || [];
      console.log(`ExecutePython: Found ${queries.length} SQL queries`);

      if (queries.length === 0) {
        // No SQL queries - just return the dry run result if it succeeded
        if (dryRunResult.success) {
          return this.formatSuccessResponse(dryRunResult, maxOutputSize, []);
        }
        return {
          success: false,
          error: 'PYTHON_ERROR',
          message: dryRunResult.error
        };
      }

      // Phase 2: Validate and execute SQL queries
      console.log('ExecutePython: Phase 2 - Executing SQL queries...');
      const queryResults: Record<number, any[]> = {};

      for (let i = 0; i < queries.length; i++) {
        const sqlQuery = queries[i];

        // Validate each SQL query
        const sqlValidation = this.validateSqlQuery(sqlQuery);
        if (!sqlValidation.isValid) {
          return {
            success: false,
            error: 'SQL_VALIDATION_FAILED',
            message: `Query ${i + 1} failed validation: ${sqlValidation.error}`,
            query: sqlQuery.substring(0, 200)
          };
        }

        // Execute SQL query
        try {
          const request = new sql.Request();
          const result = await request.query(sqlQuery);
          queryResults[i] = result.recordset;
          console.log(`ExecutePython: Query ${i + 1} returned ${result.recordset.length} rows`);

          // Warn if query returned 0 rows (might indicate wrong filter)
          if (result.recordset.length === 0) {
            console.log(`ExecutePython: WARNING - Query ${i + 1} returned 0 rows`);
          }
        } catch (sqlError) {
          const errorMsg = sqlError instanceof Error ? sqlError.message : 'Unknown SQL error';
          const hint = this.getSqlErrorHint(errorMsg, sqlQuery);
          return {
            success: false,
            error: 'SQL_EXECUTION_FAILED',
            message: `Query ${i + 1} failed: ${errorMsg}`,
            query: sqlQuery.substring(0, 300),
            hint: hint
          };
        }
      }

      // Phase 3: Re-run Python with actual data
      console.log('ExecutePython: Phase 3 - Processing data...');
      const finalResult = await this.executePython(code, queryResults, safeTimeout, false);

      if (!finalResult.success) {
        const hint = this.getPythonErrorHint(finalResult.error || '');
        const response: any = {
          success: false,
          error: 'PYTHON_ERROR',
          message: finalResult.error,
          line_number: finalResult.line_number,
          stdout: finalResult.stdout,
          stderr: finalResult.stderr
        };
        if (hint) response.hint = hint;
        if (finalResult.available_columns) response.available_columns = finalResult.available_columns;
        return response;
      }

      // Check for empty results and add warnings
      const emptyQueries = Object.entries(queryResults)
        .filter(([_, rows]) => (rows as any[]).length === 0)
        .map(([idx, _]) => parseInt(idx) + 1);

      return this.formatSuccessResponse(finalResult, maxOutputSize, queries, emptyQueries);

    } catch (error) {
      console.error('ExecutePython error:', error);
      return {
        success: false,
        error: 'EXECUTION_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Format successful response with size checking and warnings
   */
  private formatSuccessResponse(
    result: PythonResult,
    maxOutputSize: number,
    queries: string[],
    emptyQueries: number[] = []
  ): any {
    const resultStr = JSON.stringify(result.result);

    if (resultStr.length > maxOutputSize) {
      return {
        success: false,
        error: 'OUTPUT_TOO_LARGE',
        message: `Result size (${resultStr.length} bytes) exceeds limit (${maxOutputSize} bytes). Use more aggressive aggregation or filtering.`,
        hint: 'Reduce data by: adding WHERE filters, using aggregations (GROUP BY, SUM, AVG), or limiting columns in SELECT',
        queries_executed: queries.length
      };
    }

    const response: any = {
      success: true,
      result: result.result,
      stdout: result.stdout || '',
      queries_executed: queries,
      result_size_bytes: resultStr.length
    };

    // Add warning if any queries returned 0 rows
    if (emptyQueries.length > 0) {
      response.warning = `Query ${emptyQueries.join(', ')} returned 0 rows - check filter conditions`;
    }

    return response;
  }
}

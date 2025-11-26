#!/usr/bin/env python3
"""
Sandboxed Python executor for MCP SQL queries.
Receives code + SQL query results via stdin JSON, returns processed results via stdout JSON.

Two-phase execution:
1. Dry run: query() records SQL statements, returns empty DataFrames
2. Final run: query() returns actual data from injected query_data
"""

import sys
import json
import signal
import re
from io import StringIO, BytesIO
from contextlib import redirect_stdout, redirect_stderr
import base64


# Pre-import allowed packages
import pandas as pd
import numpy as np
from decimal import Decimal
from datetime import datetime, date
import scipy
import scipy.stats
from sklearn import preprocessing, cluster, decomposition, metrics

# Global storage for SQL query tracking
_sql_queries = []
_query_results = {}
_is_dry_run = True


def query(sql_query: str) -> pd.DataFrame:
    """
    Execute a SQL SELECT query and return results as DataFrame.

    In dry run mode: Records the query and returns empty DataFrame.
    In final run mode: Returns DataFrame from injected query_data.
    """
    global _sql_queries, _query_results, _is_dry_run

    query_id = len(_sql_queries)
    _sql_queries.append(sql_query)

    if _is_dry_run:
        return pd.DataFrame()

    # JSON keys are strings, so convert query_id to string for lookup
    key = str(query_id)
    if key in _query_results:
        return pd.DataFrame(_query_results[key])

    return pd.DataFrame()


def make_json_serializable(obj):
    """Convert pandas/numpy/datetime types to JSON-serializable Python types."""
    if isinstance(obj, pd.DataFrame):
        return obj.to_dict(orient='records')
    elif isinstance(obj, pd.Series):
        return obj.tolist()
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, (np.integer,)):
        return int(obj)
    elif isinstance(obj, (np.floating,)):
        return float(obj)
    elif isinstance(obj, np.bool_):
        return bool(obj)
    elif isinstance(obj, Decimal):
        return float(obj)
    elif isinstance(obj, (datetime, date)):
        return obj.isoformat()
    elif isinstance(obj, dict):
        return {str(k): make_json_serializable(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [make_json_serializable(item) for item in obj]
    elif pd.isna(obj):
        return None
    return obj


def execute_code(code: str, query_data: dict, is_dry_run: bool) -> dict:
    """Execute Python code in restricted namespace."""
    global _query_results, _sql_queries, _is_dry_run

    _query_results = query_data
    _sql_queries = []
    _is_dry_run = is_dry_run

    # Restricted namespace with safe builtins and data science packages
    namespace = {
        # Data science packages
        'pd': pd,
        'np': np,
        'scipy': scipy,
        'stats': scipy.stats,
        'sklearn': {
            'preprocessing': preprocessing,
            'cluster': cluster,
            'decomposition': decomposition,
            'metrics': metrics,
        },

        # Helper functions
        'query': query,
        'DataFrame': pd.DataFrame,
        'Series': pd.Series,

        # Safe builtins only
        '__builtins__': {
            # Basic functions
            'len': len,
            'range': range,
            'enumerate': enumerate,
            'zip': zip,
            'map': map,
            'filter': filter,
            'reversed': reversed,
            'sorted': sorted,

            # Math functions
            'sum': sum,
            'min': min,
            'max': max,
            'abs': abs,
            'round': round,
            'pow': pow,
            'divmod': divmod,

            # Type constructors
            'list': list,
            'dict': dict,
            'set': set,
            'tuple': tuple,
            'str': str,
            'int': int,
            'float': float,
            'bool': bool,
            'bytes': bytes,

            # Type checking
            'isinstance': isinstance,
            'type': type,
            'callable': callable,
            'hasattr': hasattr,

            # Iteration helpers
            'all': all,
            'any': any,
            'next': next,
            'iter': iter,

            # String/formatting
            'format': format,
            'repr': repr,
            'chr': chr,
            'ord': ord,

            # Constants
            'True': True,
            'False': False,
            'None': None,

            # Output (captured)
            'print': print,

            # Exception types (for error handling in user code)
            'Exception': Exception,
            'ValueError': ValueError,
            'TypeError': TypeError,
            'KeyError': KeyError,
            'IndexError': IndexError,
        }
    }

    stdout_capture = StringIO()
    stderr_capture = StringIO()

    try:
        with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
            exec(code, namespace)

        result = namespace.get('result', None)

        return {
            'success': True,
            'result': make_json_serializable(result),
            'stdout': stdout_capture.getvalue()[:10000],  # Limit stdout
            'stderr': stderr_capture.getvalue()[:5000],   # Limit stderr
            'queries_executed': _sql_queries.copy()
        }

    except SyntaxError as e:
        return {
            'success': False,
            'error': f"SyntaxError: {str(e)}",
            'line_number': e.lineno,
            'stdout': stdout_capture.getvalue()[:5000],
            'stderr': stderr_capture.getvalue()[:5000],
            'queries_executed': _sql_queries.copy()
        }
    except KeyError as e:
        # Extract available columns from DataFrames in namespace for better error message
        available_columns = {}
        for name, obj in namespace.items():
            if isinstance(obj, pd.DataFrame) and not name.startswith('_'):
                available_columns[name] = obj.columns.tolist()[:20]  # Limit to 20 columns

        return {
            'success': False,
            'error': f"KeyError: {str(e)}",
            'available_columns': available_columns if available_columns else None,
            'stdout': stdout_capture.getvalue()[:5000],
            'stderr': stderr_capture.getvalue()[:5000],
            'queries_executed': _sql_queries.copy()
        }
    except Exception as e:
        # Try to extract line number from traceback
        import traceback
        tb = traceback.extract_tb(e.__traceback__)
        line_number = tb[-1].lineno if tb else None

        return {
            'success': False,
            'error': f"{type(e).__name__}: {str(e)}",
            'line_number': line_number,
            'stdout': stdout_capture.getvalue()[:5000],
            'stderr': stderr_capture.getvalue()[:5000],
            'queries_executed': _sql_queries.copy()
        }


def main():
    # Set up timeout handler (Unix only)
    def timeout_handler(signum, frame):
        raise TimeoutError("Execution timed out")

    if hasattr(signal, 'SIGALRM'):
        signal.signal(signal.SIGALRM, timeout_handler)

    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)
        code = input_data.get('code', '')
        query_data = input_data.get('query_data', {})
        timeout = input_data.get('timeout', 30)
        is_dry_run = input_data.get('is_dry_run', True)

        # Set alarm (Unix only)
        if hasattr(signal, 'alarm'):
            signal.alarm(timeout)

        # Execute code
        result = execute_code(code, query_data, is_dry_run)

        # Cancel alarm
        if hasattr(signal, 'alarm'):
            signal.alarm(0)

        # Output result as JSON
        print(json.dumps(result))

    except TimeoutError:
        print(json.dumps({
            'success': False,
            'error': 'TIMEOUT: Execution exceeded time limit'
        }))
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(json.dumps({
            'success': False,
            'error': f'Invalid JSON input: {str(e)}'
        }))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': f'Executor error: {type(e).__name__}: {str(e)}'
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()

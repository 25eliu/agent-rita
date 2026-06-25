/**
 * Source for the `rita` Python helper module that lives inside the Daytona
 * compute sandbox. Uploaded to `/opt/rita.py` once at sandbox init; the init
 * codeRun adds `/opt` to `sys.path` so user code can `import rita`.
 *
 * `rita.show(obj, ...)` emits null-byte-framed JSON sentinels on stdout that
 * the MCP `execute_code` tool parses out of the run result. Regular `print()`
 * output is untouched.
 *
 * Daytona auto-extracts matplotlib figures from `plt.show()` into
 * `result.artifacts.charts` (with base64 PNGs). The matplotlib branch in
 * `rita.show` exists as a fallback when the user constructed a Figure
 * explicitly without calling `plt.show()`.
 */

export const RITA_PY_SOURCE = String.raw`"""
rita — agent-side helpers for emitting artifacts from a Daytona compute sandbox.
"""

import base64
import io
import json
import sys

_SENTINEL_HEAD = "\x00__x_agentrita_artifact__\x00"
_SENTINEL_TAIL = "\x00"


def _emit(payload):
    encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    sys.stdout.write(_SENTINEL_HEAD + encoded + _SENTINEL_TAIL)
    sys.stdout.flush()


def _is_plotly(fig):
    return type(fig).__module__.startswith("plotly.")


def _is_matplotlib(fig):
    return type(fig).__module__.startswith("matplotlib.")


def _is_dataframe(obj):
    return type(obj).__module__.startswith("pandas.") and hasattr(obj, "to_dict")


def _plotly_to_html(fig):
    return fig.to_html(include_plotlyjs="cdn", full_html=False)


def _plotly_to_png_b64(fig):
    return base64.b64encode(fig.to_image(format="png")).decode("ascii")


def _matplotlib_to_png_b64(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=120, bbox_inches="tight")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def show(obj, *, name="", caption="", png=False):
    """
    Emit an artifact for the agent to render.

    Supported types:
      - plotly.graph_objects.Figure   -> interactive HTML (CDN plotly.js); png=True for static PNG
      - matplotlib.figure.Figure      -> base64 PNG <img>
      - pandas.DataFrame              -> TableArtifact (rendered as sortable/filterable table)
    """
    if _is_plotly(obj):
        if png:
            b64 = _plotly_to_png_b64(obj)
            _emit({
                "kind": "html",
                "name": name or "Chart",
                "caption": caption,
                "content": '<img src="data:image/png;base64,' + b64 + '" alt="' + (caption or name) + '" style="max-width:100%;height:auto">',
            })
        else:
            _emit({
                "kind": "html",
                "name": name or "Chart",
                "caption": caption,
                "content": _plotly_to_html(obj),
            })
        return

    if _is_matplotlib(obj):
        b64 = _matplotlib_to_png_b64(obj)
        _emit({
            "kind": "html",
            "name": name or "Chart",
            "caption": caption,
            "content": '<img src="data:image/png;base64,' + b64 + '" alt="' + (caption or name) + '" style="max-width:100%;height:auto">',
        })
        return

    if _is_dataframe(obj):
        rows = obj.to_dict(orient="records")
        _emit({
            "kind": "table",
            "name": name or "Table",
            "caption": caption,
            "rows": rows,
        })
        return

    raise TypeError(
        "rita.show: unsupported object type " + type(obj).__name__ +
        ". Expected plotly.Figure, matplotlib.Figure, or pandas.DataFrame."
    )
`;

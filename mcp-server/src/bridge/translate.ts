/**
 * Wire-shape translators for workspace tools.
 *
 * MCP-facing arg names use snapshot vocabulary (origin, widget_id, data_args).
 * Browser-facing wire shape uses Ada vocabulary (id, input_args). These
 * helpers bridge the two — direct port of workspace_mcp/server.py:411-435.
 */

export interface WidgetDataRequestInput {
  origin: string;
  widget_id: string;
  data_args: Record<string, unknown>;
  widget_uuid?: string | null;
  ssm_request?: Record<string, unknown> | null;
}

export interface ParamOptionsRequestInput {
  origin: string;
  widget_id: string;
  param_name: string;
  data_args: Record<string, unknown>;
}

export function dataSourcePayloads(
  items: WidgetDataRequestInput[],
): Array<Record<string, unknown>> {
  return items.map((item) => ({
    origin: item.origin,
    id: item.widget_id,
    input_args: item.data_args,
    widget_uuid: item.widget_uuid ?? null,
    ssm_request: item.ssm_request ?? null,
  }));
}

export function paramOptionsPayloads(
  items: ParamOptionsRequestInput[],
): Array<Record<string, unknown>> {
  return items.map((item) => ({
    origin: item.origin,
    id: item.widget_id,
    param: item.param_name,
    options_endpoint_input_args: item.data_args,
  }));
}

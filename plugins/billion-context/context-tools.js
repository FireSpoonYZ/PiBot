import {
  ACP_STATUS_TOOL,
  COMPRESS_TOOL,
  DECOMPRESS_TOOL,
  SEARCH_CONTEXT_TOOL,
} from 'acp-kernel';

// 四个工具复用 acp-kernel 声明，执行映射到 controller。
const CONTEXT_TOOLS = [
  { declaration: COMPRESS_TOOL, method: 'compress' },
  { declaration: DECOMPRESS_TOOL, method: 'decompress' },
  { declaration: SEARCH_CONTEXT_TOOL, method: 'search' },
  { declaration: ACP_STATUS_TOOL, method: 'status' },
];

/** 注册原名工具，以便恢复历史排队调用。 */
export function createContextTools(controller, defineTool) {
  return CONTEXT_TOOLS.map(({ declaration, method }) =>
    defineTool({
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.input_schema,
      replay: 'safe',
      execute: (args, api, context) => controller[method](args, api, context),
    }),
  );
}

export type WeappPrompt = {
  name: string;
  description: string;
  arguments?: {
    name: string;
    description?: string;
    required?: boolean;
    enum?: string[];
  }[];
  load: (args: Record<string, string | undefined>) => Promise<string>;
};

const connectionFlow = [
  "Use this MCP with a stable workflow.",
  "",
  "1. Call mp_ensureConnection first.",
  "2. Call mp_healthCheck to confirm the session, route, and log listener status.",
  "3. If healthCheck is healthy, call mp_currentPage to confirm the active page.",
  "4. Only then call mp_screenshot, page_*, or element_* tools.",
  "5. If healthCheck says recovery is needed, call mp_recoverConnection instead of blindly retrying other tools.",
  "6. If a tool says PROJECT_SELECTION_REQUIRED, call mp_listProjects or provide projectSelection to mp_ensureConnection.",
].join("\n");

export function createPrompts(): WeappPrompt[] {
  return [
    {
      name: "connect-and-inspect-home",
      description:
        "Connect to the mini program, confirm the current page, then inspect the home page UI.",
      arguments: [
        {
          name: "focus",
          description: "Optional UI area to inspect after connecting.",
          required: false,
        },
      ],
      load: async ({ focus }) => {
        const target = focus?.trim() ? ` Focus on: ${focus.trim()}.` : "";
        return [
          connectionFlow,
          "",
          "After connection succeeds:",
          "- Call mp_currentPage.",
          "- Call mp_screenshot.",
          "- If needed, use page_getElements or page_getElement to inspect the UI tree.",
          `- Report the current page path and whether the requested home-page UI is visible.${target}`,
          "",
          "If connection fails twice, stop and report the exact MCP error instead of looping.",
        ].join("\n");
      },
    },
    {
      name: "recover-connection",
      description:
        "Recover a failed mini program connection using the MCP's expected retry order.",
      arguments: [
        {
          name: "lastError",
          description: "Exact error message returned by the MCP client.",
          required: false,
        },
      ],
      load: async ({ lastError }) => {
        const errorLine = lastError?.trim()
          ? `Last error: ${lastError.trim()}`
          : "Last error: unavailable";
        return [
          connectionFlow,
          "",
          errorLine,
          "",
          "Recovery order:",
          "- First call mp_healthCheck.",
          "- If recovery is needed, call mp_recoverConnection.",
          "- If the MCP asks for project selection, call mp_listProjects or retry mp_ensureConnection with projectSelection.",
          "- If the MCP reports connect mode failure, check whether WeChat DevTools automation is reachable at the configured wsEndpoint.",
          "- Do not spam the same recovery call more than twice with the same arguments.",
        ].join("\n");
      },
    },
    {
      name: "connect-and-screenshot",
      description:
        "Connect first, then capture a screenshot from the active mini program page.",
      load: async () => {
        return [
          connectionFlow,
          "",
          "Workflow:",
          "- Call mp_ensureConnection.",
          "- Call mp_currentPage to confirm the active route.",
          "- Call mp_screenshot.",
          "- Report the saved screenshot path or the inline image result.",
        ].join("\n");
      },
    },
  ];
}

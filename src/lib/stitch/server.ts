import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadServerStitchConfig } from "../../config/stitch.js";

const STITCH_MCP_URL = "https://stitch.googleapis.com/mcp";
const LOGO_REFERENCE_TITLE = "Monarch Official Logo Reference";
const HOME_FRAMEWORK_TITLE = "Monarch Home Framework ";
const MCP_PROTOCOL_VERSION = "2025-06-18";

export type StitchDeviceType = "MOBILE";

export interface StitchScreenMetadata {
  height: number;
  htmlUrl: string | null;
  projectId: string;
  screenId: string;
  screenName: string | null;
  screenshotUrl: string;
  width: number;
}

export interface GenerateStitchInput {
  designSystem?: string;
  deviceType: StitchDeviceType;
  projectId: string;
  prompt: string;
}

export interface StitchGateway {
  createProject(title: string): Promise<string>;
  ensureHomeFrameworkReference?(projectId: string, filePath: string): Promise<string>;
  uploadReferenceImage?(projectId: string, body: Uint8Array, title: string): Promise<string>;
  editScreen?(input: GenerateStitchInput & { screenId: string }): Promise<StitchScreenMetadata[]>;
  findDesignSystem?(projectId: string): Promise<string | null>;
  getScreen?(projectId: string, screenId: string): Promise<StitchScreenMetadata>;
  generate(input: GenerateStitchInput): Promise<StitchScreenMetadata[]>;
  listScreens(projectId: string): Promise<StitchScreenMetadata[]>;
}

export interface StitchMcpTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
}

export interface StitchMcpConnection {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<StitchMcpTool[]>;
}

export interface StitchReferenceUploader {
  upload(projectId: string, filePath: string, title: string): Promise<string>;
  uploadBytes(projectId: string, body: Uint8Array, title: string): Promise<string>;
}

export function createOfficialStitchReferenceUploader(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): StitchReferenceUploader {
  const uploadBytes = async (projectId: string, image: Uint8Array, title: string): Promise<string> => {
      const safeProjectId = resourceId(projectId, "projects");
      if (!Buffer.from(image.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error("Stitch reference upload requires PNG image bytes");
      }
      // This is the BatchCreateScreens request used by Google's official
      // Stitch SDK Project.upload(). The MCP catalogue has no image-upload tool.
      const response = await fetcher(
        `https://stitch.googleapis.com/v1/projects/${safeProjectId}/screens:batchCreate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
          },
          body: JSON.stringify({
            parent: `projects/${safeProjectId}`,
            requests: [{ screen: {
              screenType: "IMAGE",
              isCreatedByClient: true,
              screenshot: {
                fileContentBase64: Buffer.from(image).toString("base64"),
                mimeType: "image/png",
              },
              title,
            } }],
            createScreenInstances: true,
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!response.ok) {
        throw new Error(`Stitch reference upload failed with HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      const results = dataField(payload, "results");
      if (!Array.isArray(results) || results.length !== 1) {
        throw new Error("Stitch image upload returned no unique reference screen");
      }
      const uploaded = dataField(results[0], "screen");
      const name = stringField(uploaded, "name") ?? stringField(uploaded, "id") ??
        stringField(dataField(uploaded, "screenshot"), "name")?.split("/files/").at(-1);
      if (!name) throw new Error("Stitch image upload did not return a reference screen ID");
      return resourceId(name, "screens");
  };
  return {
    uploadBytes,
    async upload(projectId, filePath, title) {
      return uploadBytes(projectId, await readFile(filePath), title);
    },
  };
}

interface McpResponse {
  error?: { code?: number; message?: string };
  result?: unknown;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown, field: string): string | null {
  const fieldValue = object(value)?.[field];
  return typeof fieldValue === "string" && fieldValue.trim()
    ? fieldValue.trim()
    : null;
}

function dataField(value: unknown, field: string): unknown {
  return object(value)?.[field];
}

function parseMcpResponse(body: string, contentType: string | null): McpResponse {
  if (contentType?.includes("text/event-stream")) {
    const messages = body
      .split(/\r?\n\r?\n/)
      .flatMap((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
    const last = messages.at(-1);
    if (!last) throw new Error("Stitch MCP returned an empty event stream");
    return JSON.parse(last) as McpResponse;
  }
  return JSON.parse(body) as McpResponse;
}

function unwrapToolResult(result: unknown): unknown {
  const wrapper = object(result);
  if (!wrapper) throw new Error("Stitch MCP returned a malformed tool result");
  if (wrapper.isError === true) {
    const content = Array.isArray(wrapper.content) ? wrapper.content : [];
    const message = content
      .map((item) => stringField(item, "text"))
      .filter(Boolean)
      .join(" ");
    throw new Error(`Stitch MCP tool failed: ${message || "unknown error"}`);
  }
  if (wrapper.structuredContent !== undefined) return wrapper.structuredContent;
  const content = Array.isArray(wrapper.content) ? wrapper.content : [];
  for (const item of content) {
    const text = stringField(item, "text");
    if (!text) continue;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return wrapper;
}

export class DirectStitchMcpConnection implements StitchMcpConnection {
  private nextId = 1;
  private initialized: Promise<void> | undefined;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async post(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
    notification = false,
  ): Promise<unknown> {
    const request = {
      jsonrpc: "2.0",
      ...(!notification ? { id: this.nextId++ } : {}),
      method,
      ...(params ? { params } : {}),
    };
    const response = await this.fetcher(STITCH_MCP_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Stitch MCP ${method} failed with HTTP ${response.status}`);
    }
    if (notification) return null;
    const payload = parseMcpResponse(
      await response.text(),
      response.headers.get("content-type"),
    );
    if (payload.error) {
      throw new Error(
        `Stitch MCP ${method} failed: ${payload.error.message ?? "unknown error"}`,
      );
    }
    return payload.result;
  }

  private async initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const result = await this.post("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "monarch-outbound-agent", version: "0.1.0" },
      });
      if (!object(result)?.serverInfo) {
        throw new Error("Stitch MCP did not return server information");
      }
      await this.post("notifications/initialized", undefined, 30_000, true);
    })();
    try {
      await this.initialized;
    } catch (error) {
      this.initialized = undefined;
      throw error;
    }
  }

  async listTools(): Promise<StitchMcpTool[]> {
    await this.initialize();
    const tools: StitchMcpTool[] = [];
    let cursor: string | null = null;
    do {
      const result = object(
        await this.post("tools/list", cursor ? { cursor } : {}),
      );
      if (!result || !Array.isArray(result.tools)) {
        throw new Error("Stitch MCP returned an invalid tool list");
      }
      for (const tool of result.tools) {
        const name = stringField(tool, "name");
        if (!name) continue;
        const description = stringField(tool, "description");
        const inputSchema = object(dataField(tool, "inputSchema"));
        tools.push({
          name,
          ...(description ? { description } : {}),
          ...(inputSchema ? { inputSchema } : {}),
        });
      }
      cursor = stringField(result, "nextCursor");
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    const result = await this.post(
      "tools/call",
      { name, arguments: args },
      name === "generate_screen_from_text" || name === "edit_screens"
        ? 300_000
        : 30_000,
    );
    return unwrapToolResult(result);
  }
}

function resourceId(value: string, kind: "projects" | "screens"): string {
  const parts = value.split("/");
  const id = parts.at(-1);
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Stitch MCP returned an invalid ${kind} identifier`);
  }
  return id;
}

function positiveDimension(value: unknown): number | null {
  const dimension = Number(value);
  return Number.isSafeInteger(dimension) && dimension > 0 ? dimension : null;
}

function fullSizeScreenshotUrl(value: string, width: number): string {
  const url = new URL(value);
  if (url.hostname === "lh3.googleusercontent.com") {
    url.pathname = `${url.pathname.replace(/=w\d+$/, "")}=w${width}`;
  }
  return url.toString();
}

function screenMetadata(value: unknown, projectId: string): StitchScreenMetadata | null {
  const name = stringField(value, "name") ?? stringField(value, "id");
  if (!name) return null;
  const title = stringField(value, "title");
  const screenshotUrl = stringField(dataField(value, "screenshot"), "downloadUrl");
  const width = positiveDimension(dataField(value, "width"));
  const height = positiveDimension(dataField(value, "height"));
  if (!screenshotUrl || width === null || height === null) return null;
  return {
    height,
    htmlUrl: stringField(dataField(value, "htmlCode"), "downloadUrl"),
    projectId,
    screenId: resourceId(name, "screens"),
    screenName: title,
    screenshotUrl: fullSizeScreenshotUrl(screenshotUrl, width),
    width,
  };
}

function generatedScreenObjects(value: unknown): unknown[] {
  const components = dataField(value, "outputComponents");
  const screens: unknown[] = [];
  if (Array.isArray(components)) {
    for (const component of components) {
      const designScreens = dataField(dataField(component, "design"), "screens");
      if (Array.isArray(designScreens)) screens.push(...designScreens);
    }
  }
  return screens;
}

export function createGoogleStitchMcpGateway(
  mcp: StitchMcpConnection,
  referenceUploader?: StitchReferenceUploader,
): StitchGateway {
  async function listRawScreens(projectId: string): Promise<unknown[]> {
    const result = await mcp.callTool("list_screens", { projectId });
    const screens = dataField(result, "screens");
    if (screens === undefined && object(result)) return [];
    if (!Array.isArray(screens)) {
      throw new Error("Stitch MCP list_screens returned an invalid screen list");
    }
    return screens;
  }

  async function screensFromOutput(result: unknown, projectId: string): Promise<StitchScreenMetadata[]> {
    const generated = new Map<string, StitchScreenMetadata>();
    const directScreens = generatedScreenObjects(result);
    // A phone mockup can be labeled DESKTOP when its background canvas is wide.
    // Prefer UI-identified resources over auxiliary website photos and logos.
    const uiScreens = directScreens.filter((screen) =>
      stringField(screen, "deviceType") ||
      stringField(dataField(screen, "htmlCode"), "downloadUrl"),
    );
    for (const screen of uiScreens.length ? uiScreens : directScreens) {
      const name = stringField(screen, "name");
      const complete = screenMetadata(screen, projectId)
        ? screen
        : name
          ? await mcp.callTool("get_screen", { name })
          : screen;
      const metadata = screenMetadata(complete, projectId);
      if (metadata) generated.set(metadata.screenId, metadata);
    }
    if (generated.size === 0) {
      throw new Error("Stitch MCP outputComponents contained no usable app screens");
    }
    return [...generated.values()];
  }

  return {
    async createProject(title) {
      const result = await mcp.callTool("create_project", { title });
      const name = stringField(result, "name") ?? stringField(result, "result");
      if (!name) throw new Error("Stitch MCP created a project without an ID");
      return resourceId(name, "projects");
    },

    async ensureHomeFrameworkReference(projectId, filePath) {
      const digest = createHash("sha256").update(await readFile(filePath)).digest("hex");
      const title = `${HOME_FRAMEWORK_TITLE}${digest.slice(0, 16)}`;
      for (const screen of await listRawScreens(projectId)) {
        if (stringField(screen, "title") !== title) continue;
        const name = stringField(screen, "name") ?? stringField(screen, "id");
        if (name) return resourceId(name, "screens");
      }
      if (!referenceUploader) {
        throw new Error("Stitch image upload is not configured");
      }
      return referenceUploader.upload(projectId, filePath, title);
    },

    async uploadReferenceImage(projectId, body, title) {
      if (!referenceUploader) throw new Error("Stitch image upload is not configured");
      return referenceUploader.uploadBytes(projectId, body, title);
    },

    async editScreen(input) {
      const result = await mcp.callTool("edit_screens", {
        deviceType: input.deviceType,
        projectId: input.projectId,
        prompt: input.prompt,
        selectedScreenIds: [resourceId(input.screenId, "screens")],
      });
      return screensFromOutput(result, input.projectId);
    },

    async findDesignSystem(projectId) {
      const result = await mcp.callTool("list_design_systems", { projectId });
      const assets = dataField(result, "designSystems");
      if (!Array.isArray(assets)) return null;
      for (const asset of assets) {
        const name = stringField(asset, "name");
        if (name?.startsWith("assets/")) return name;
      }
      return null;
    },

    async getScreen(projectId, screenId) {
      const result = await mcp.callTool("get_screen", {
        name: `projects/${projectId}/screens/${resourceId(screenId, "screens")}`,
      });
      const metadata = screenMetadata(result, projectId);
      if (!metadata || metadata.screenId !== screenId) {
        throw new Error(`Stitch MCP could not verify screen ${screenId}`);
      }
      return metadata;
    },

    async generate(input) {
      const result = await mcp.callTool("generate_screen_from_text", {
        ...(input.designSystem ? { designSystem: input.designSystem } : {}),
        deviceType: input.deviceType,
        projectId: input.projectId,
        prompt: input.prompt,
      });
      return screensFromOutput(result, input.projectId);
    },

    async listScreens(projectId) {
      const screens: StitchScreenMetadata[] = [];
      for (const screen of await listRawScreens(projectId)) {
        const title = stringField(screen, "title");
        if (title === LOGO_REFERENCE_TITLE || title?.startsWith(HOME_FRAMEWORK_TITLE)) continue;
        const name = stringField(screen, "name");
        if (!name) continue;
        const complete = screenMetadata(screen, projectId)
          ? screen
          : await mcp.callTool("get_screen", { name });
        const metadata = screenMetadata(complete, projectId);
        if (metadata) screens.push(metadata);
      }
      return screens;
    },
  };
}

let gatewaySingleton: StitchGateway | undefined;

export function getServerStitchGateway(): StitchGateway {
  if (gatewaySingleton) return gatewaySingleton;
  const { apiKey } = loadServerStitchConfig();
  gatewaySingleton = createGoogleStitchMcpGateway(
    new DirectStitchMcpConnection(apiKey),
    createOfficialStitchReferenceUploader(apiKey),
  );
  return gatewaySingleton;
}

export async function listAvailableStitchMcpTools(): Promise<StitchMcpTool[]> {
  const { apiKey } = loadServerStitchConfig();
  return new DirectStitchMcpConnection(apiKey).listTools();
}

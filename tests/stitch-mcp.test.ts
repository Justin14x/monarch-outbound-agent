import { describe, expect, it, vi } from "vitest";

import { STITCH_HOME_FRAMEWORK_IMAGE_PATH } from "../src/config/stitch-home-framework.js";
import {
  createOfficialStitchReferenceUploader,
  createGoogleStitchMcpGateway,
  DirectStitchMcpConnection,
  type StitchMcpConnection,
  type StitchReferenceUploader,
} from "../src/lib/stitch/server.js";

const PROJECT_ID = "14994324819767345316";
const LOGO_SCREEN = {
  name: `projects/${PROJECT_ID}/screens/logo-1`,
  title: "Monarch Official Logo Reference",
  screenshot: { downloadUrl: "https://example.com/logo.png" },
};
const APP_SCREEN = {
  deviceType: "MOBILE",
  height: "844",
  name: `projects/${PROJECT_ID}/screens/home-1`,
  title: "Home",
  screenshot: { downloadUrl: "https://example.com/home.png" },
  htmlCode: { downloadUrl: "https://example.com/home.html" },
  width: "390",
};

function mockMcp(initialScreens: unknown[] = []) {
  let screens = initialScreens;
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "create_project") return { name: `projects/${PROJECT_ID}` };
    if (name === "list_screens") return { screens };
    if (name === "get_screen") return APP_SCREEN;
    if (name === "generate_screen_from_text" || name === "edit_screens") {
      screens = [...screens, APP_SCREEN];
      return { outputComponents: [{ design: { screens: [APP_SCREEN] } }] };
    }
    throw new Error(`Unexpected MCP tool: ${name}`);
  });
  return { connection: { callTool, listTools: vi.fn() } as StitchMcpConnection, callTool };
}

describe("direct Stitch MCP gateway", () => {
  it("maps project creation to the live create_project tool", async () => {
    const mcp = mockMcp();
    const gateway = createGoogleStitchMcpGateway(mcp.connection);
    expect(await gateway.createProject("Monarch - Skin Hub Med Spa")).toBe(PROJECT_ID);
    expect(mcp.callTool).toHaveBeenCalledWith("create_project", {
      title: "Monarch - Skin Hub Med Spa",
    });
  });

  it("uses generate_screen_from_text with the stored prompt and MOBILE device", async () => {
    const mcp = mockMcp();
    const gateway = createGoogleStitchMcpGateway(mcp.connection);
    const screens = await gateway.generate({
      deviceType: "MOBILE",
      projectId: PROJECT_ID,
      prompt: "Stored website-only prompt",
    });
    expect(mcp.callTool).toHaveBeenCalledWith("generate_screen_from_text", {
      deviceType: "MOBILE",
      projectId: PROJECT_ID,
      prompt: "Stored website-only prompt",
    });
    expect(screens).toEqual([{
      height: 844,
      htmlUrl: "https://example.com/home.html",
      projectId: PROJECT_ID,
      screenId: "home-1",
      screenName: "Home",
      screenshotUrl: "https://example.com/home.png",
      width: 390,
    }]);
  });

  it("uploads the reference only once and edits that screen through edit_screens", async () => {
    const screens: unknown[] = [];
    const callTool = vi.fn(async (name: string) => {
      if (name === "list_screens") return { screens };
      if (name === "edit_screens") {
        return { outputComponents: [{ design: { screens: [APP_SCREEN] } }] };
      }
      throw new Error(`Unexpected MCP tool: ${name}`);
    });
    const uploader: StitchReferenceUploader = {
      upload: vi.fn(async (_projectId, _filePath, title) => {
        screens.push({
          name: `projects/${PROJECT_ID}/screens/framework-1`,
          title,
          screenshot: { downloadUrl: "https://example.com/framework.png" },
          width: "851",
          height: "1847",
        });
        return "framework-1";
      }),
      uploadBytes: vi.fn(async () => "uploaded-image-1"),
    };
    const gateway = createGoogleStitchMcpGateway({ callTool, listTools: vi.fn() }, uploader);
    const first = await gateway.ensureHomeFrameworkReference!(PROJECT_ID, STITCH_HOME_FRAMEWORK_IMAGE_PATH);
    const second = await gateway.ensureHomeFrameworkReference!(PROJECT_ID, STITCH_HOME_FRAMEWORK_IMAGE_PATH);
    expect(first).toBe("framework-1");
    expect(second).toBe(first);
    expect(uploader.upload).toHaveBeenCalledOnce();
    expect(await gateway.listScreens(PROJECT_ID)).toEqual([]);
    const edited = await gateway.editScreen!({
      deviceType: "MOBILE",
      projectId: PROJECT_ID,
      prompt: "Adapt the selected image for the prospect",
      screenId: first,
    });
    expect(callTool).toHaveBeenCalledWith("edit_screens", {
      deviceType: "MOBILE",
      projectId: PROJECT_ID,
      prompt: "Adapt the selected image for the prospect",
      selectedScreenIds: ["framework-1"],
    });
    expect(edited.map((item) => item.screenId)).toEqual(["home-1"]);
  });

  it("generates without requiring or referencing an existing logo screen", async () => {
    const mcp = mockMcp([LOGO_SCREEN]);
    const gateway = createGoogleStitchMcpGateway(mcp.connection);
    const screens = await gateway.generate({
      deviceType: "MOBILE",
      projectId: PROJECT_ID,
      prompt: "Generate app screens. This is the website: https://skinhubmedspa.com/",
    });
    expect(mcp.callTool).toHaveBeenCalledWith("generate_screen_from_text", {
      deviceType: "MOBILE",
      projectId: PROJECT_ID,
      prompt: "Generate app screens. This is the website: https://skinhubmedspa.com/",
    });
    expect(screens).toHaveLength(1);
    expect(screens[0]?.screenId).toBe("home-1");
  });

  it("retrieves missing screen metadata with get_screen", async () => {
    const mcp = mockMcp([{ name: APP_SCREEN.name, title: "Home" }]);
    const gateway = createGoogleStitchMcpGateway(mcp.connection);
    const screens = await gateway.listScreens(PROJECT_ID);
    expect(mcp.callTool).toHaveBeenCalledWith("get_screen", {
      name: APP_SCREEN.name,
    });
    expect(screens[0]?.screenId).toBe("home-1");
  });

  it("treats an omitted screens field as an empty Stitch project", async () => {
    const gateway = createGoogleStitchMcpGateway({
      callTool: vi.fn(async () => ({})),
      listTools: vi.fn(),
    });
    expect(await gateway.listScreens(PROJECT_ID)).toEqual([]);
  });

  it("uses screens returned by generation when list_screens has not indexed them", async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === "generate_screen_from_text") {
        return { outputComponents: [{ design: { screens: [APP_SCREEN] } }] };
      }
      if (name === "list_screens") return { screens: [] };
      throw new Error(`Unexpected MCP tool: ${name}`);
    });
    const gateway = createGoogleStitchMcpGateway({
      callTool,
      listTools: vi.fn(),
    });
    const screens = await gateway.generate({
      deviceType: "MOBILE",
      projectId: PROJECT_ID,
      prompt: "Stored prompt",
    });
    expect(screens.map((screen) => screen.screenId)).toEqual(["home-1"]);
    expect(callTool).not.toHaveBeenCalledWith("list_screens", expect.anything());
  });

  it("ignores auxiliary website, image, and logo resources in design.screens", async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === "generate_screen_from_text") {
        return { outputComponents: [{ design: { screens: [
          { name: `projects/${PROJECT_ID}/screens/text`, title: "Extracted website text" },
          { name: `projects/${PROJECT_ID}/screens/image`, title: "Treatment room photo", screenshot: { downloadUrl: "https://example.com/photo.png" } },
          { name: `projects/${PROJECT_ID}/screens/logo`, title: "Generated logo", screenshot: { downloadUrl: "https://example.com/logo.png" } },
          APP_SCREEN,
        ] } }] };
      }
      throw new Error(`Unexpected MCP tool: ${name}`);
    });
    const gateway = createGoogleStitchMcpGateway({ callTool, listTools: vi.fn() });
    const screens = await gateway.generate({
      deviceType: "MOBILE",
      projectId: PROJECT_ID,
      prompt: "Skin Hub website prompt",
    });
    expect(screens.map((screen) => screen.screenId)).toEqual(["home-1"]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("accepts a screenshot-bearing UI screen even when Stitch labels it DESKTOP", async () => {
    const desktopLabeledPhone = {
      ...APP_SCREEN,
      deviceType: "DESKTOP",
      height: "2048",
      width: "2560",
    };
    const callTool = vi.fn(async () => ({ outputComponents: [{ design: { screens: [
      { name: `projects/${PROJECT_ID}/screens/photo`, title: "Website photo", screenshot: { downloadUrl: "https://example.com/photo.png" }, width: "1200", height: "800" },
      desktopLabeledPhone,
    ] } }] }));
    const gateway = createGoogleStitchMcpGateway({ callTool, listTools: vi.fn() });
    const screens = await gateway.generate({ deviceType: "MOBILE", projectId: PROJECT_ID, prompt: "Phone mockup" });
    expect(screens.map((screen) => screen.screenId)).toEqual(["home-1"]);
    expect(screens[0]).toMatchObject({ width: 2560, height: 2048 });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("accepts a direct screenshot-only screen when Stitch omits device metadata", async () => {
    const { deviceType: _deviceType, htmlCode: _htmlCode, ...screenshotOnly } = APP_SCREEN;
    const callTool = vi.fn(async () => ({ outputComponents: [{ design: { screens: [screenshotOnly] } }] }));
    const gateway = createGoogleStitchMcpGateway({ callTool, listTools: vi.fn() });
    const screens = await gateway.generate({ deviceType: "MOBILE", projectId: PROJECT_ID, prompt: "Phone mockup" });
    expect(screens.map((screen) => screen.screenId)).toEqual(["home-1"]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("requests the full screen width from Google's thumbnail CDN", async () => {
    const callTool = vi.fn(async () => ({ outputComponents: [{ design: { screens: [{
      ...APP_SCREEN,
      screenshot: { downloadUrl: "https://lh3.googleusercontent.com/aida/example" },
    }] } }] }));
    const gateway = createGoogleStitchMcpGateway({ callTool, listTools: vi.fn() });
    const screens = await gateway.generate({
      deviceType: "MOBILE",
      projectId: PROJECT_ID,
      prompt: "Test",
    });
    expect(screens[0]?.screenshotUrl).toBe("https://lh3.googleusercontent.com/aida/example=w390");
  });

  it("does not mistake Stitch's descriptive response text for a generated screen", async () => {
    const callTool = vi.fn(async (name: string) =>
      name === "generate_screen_from_text"
        ? { outputComponents: [{ text: "No screen could be generated" }] }
        : { screens: [] },
    );
    const gateway = createGoogleStitchMcpGateway({
      callTool,
      listTools: vi.fn(),
    });
    await expect(gateway.generate({
      deviceType: "MOBILE",
      projectId: PROJECT_ID,
      prompt: "Stored prompt",
    })).rejects.toThrow("outputComponents contained no usable app screens");
  });
});

describe("official Stitch image upload request", () => {
  it("sends the repository PNG as one private reference screen using server-side credentials", async () => {
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const requests = body.requests as Array<{ screen: {
        screenshot: { fileContentBase64: string; mimeType: string };
        title: string;
      } }>;
      expect(body.parent).toBe(`projects/${PROJECT_ID}`);
      expect(body.createScreenInstances).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.screen.screenshot.mimeType).toBe("image/png");
      expect(Buffer.from(requests[0]!.screen.screenshot.fileContentBase64, "base64").subarray(0, 8))
        .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(requests[0]?.screen.title).toBe("Framework test");
      return Response.json({ results: [{ screen: { name: `projects/${PROJECT_ID}/screens/framework-1` } }] });
    }) as unknown as typeof fetch;
    const uploader = createOfficialStitchReferenceUploader("server-only-key", fetcher);
    expect(await uploader.upload(PROJECT_ID, STITCH_HOME_FRAMEWORK_IMAGE_PATH, "Framework test"))
      .toBe("framework-1");
    expect(fetcher).toHaveBeenCalledWith(
      `https://stitch.googleapis.com/v1/projects/${PROJECT_ID}/screens:batchCreate`,
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Goog-Api-Key": "server-only-key" }),
        method: "POST",
      }),
    );
  });
});

describe("direct Stitch MCP protocol client", () => {
  it("initializes, discovers tools, and unwraps structured tool results", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      const method = request.method;
      const result = method === "initialize"
        ? { serverInfo: { name: "Stitch" } }
        : method === "tools/list"
          ? { tools: [{ name: "create_project" }] }
          : { structuredContent: { name: `projects/${PROJECT_ID}` } };
      return new Response(
        method === "notifications/initialized"
          ? null
          : JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        { status: method === "notifications/initialized" ? 202 : 200 },
      );
    }) as unknown as typeof fetch;
    const client = new DirectStitchMcpConnection("private-test-key", fetcher);
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["create_project"]);
    expect(await client.callTool("create_project", { title: "Test" })).toEqual({
      name: `projects/${PROJECT_ID}`,
    });
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(vi.mocked(fetcher).mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-Goog-Api-Key": "private-test-key",
    });
  });
});

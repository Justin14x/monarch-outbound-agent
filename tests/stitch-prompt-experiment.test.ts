import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import type { StitchGateway } from "../src/lib/stitch/server.js";
import { runStitchPromptExperiment, validateExperimentPrompt } from "../src/modules/stitch/stitch-prompt-experiment.js";

const prompt = "Create one native mobile Home screen for Skin Hub Med Spa from its public website, with no attached reference image.";

describe("isolated Stitch prompt experiments", () => {
  it("validates prompt text before any project is created", () => {
    expect(() => validateExperimentPrompt("too short")).toThrow(/40/);
    expect(validateExperimentPrompt(`  ${prompt}  `)).toBe(prompt);
  });

  it("creates one fresh project, makes exactly one generation call, and saves only local output", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "monarch-prompt-test-"));
    const png = await sharp({ create: { width: 390, height: 844, channels: 4, background: "#ffffff" } }).png().toBuffer();
    const generate = vi.fn().mockResolvedValue([{ projectId: "p1", screenId: "s1", screenName: "Home", width: 390, height: 844, screenshotUrl: "https://example.com/s1.png", htmlUrl: null }]);
    const gateway: StitchGateway = {
      createProject: vi.fn().mockResolvedValue("p1"),
      generate,
      listScreens: vi.fn().mockResolvedValue([]),
    };
    const result = await runStitchPromptExperiment({
      outputDir,
      prompt,
      title: "test project",
      gateway,
      fetcher: vi.fn().mockResolvedValue(new Response(png, { status: 200 })) as typeof fetch,
    });
    expect(gateway.createProject).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledExactlyOnceWith({ projectId: "p1", deviceType: "MOBILE", prompt });
    expect(gateway.listScreens).not.toHaveBeenCalled();
    expect(result.status).toBe("COMPLETE");
    expect(result.screens).toHaveLength(1);
    expect(await readFile(result.screens[0]!.localPath!)).toEqual(png);
    expect(JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8")).projectId).toBe("p1");
  });

  it("uploads a reference to a fresh project and makes exactly one edit call", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "monarch-reference-test-"));
    const png = await sharp({ create: { width: 390, height: 844, channels: 4, background: "#ffffff" } }).png().toBuffer();
    const referenceImagePath = "/example/med-spa-reference.png";
    const ensureHomeFrameworkReference = vi.fn().mockResolvedValue("reference-1");
    const editScreen = vi.fn().mockResolvedValue([{ projectId: "p3", screenId: "s3", screenName: "Home", width: 390, height: 844, screenshotUrl: "https://example.com/s3.png", htmlUrl: null }]);
    const generate = vi.fn();
    const gateway: StitchGateway = {
      createProject: vi.fn().mockResolvedValue("p3"),
      ensureHomeFrameworkReference,
      editScreen,
      generate,
      listScreens: vi.fn().mockResolvedValue([]),
    };
    const result = await runStitchPromptExperiment({
      outputDir,
      prompt,
      referenceImagePath,
      title: "reference test",
      gateway,
      fetcher: vi.fn().mockResolvedValue(new Response(png, { status: 200 })) as typeof fetch,
    });
    expect(ensureHomeFrameworkReference).toHaveBeenCalledExactlyOnceWith("p3", referenceImagePath);
    expect(editScreen).toHaveBeenCalledExactlyOnceWith({ projectId: "p3", deviceType: "MOBILE", prompt, screenId: "reference-1" });
    expect(generate).not.toHaveBeenCalled();
    expect(gateway.listScreens).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "COMPLETE", projectId: "p3", referenceImagePath, referenceScreenId: "reference-1" });
    expect(result.screens).toHaveLength(1);
    expect(await readFile(result.screens[0]!.localPath!)).toEqual(png);
  });

  it("records a failed generation without retrying", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "monarch-prompt-fail-"));
    const generate = vi.fn().mockRejectedValue(new Error("Stitch unavailable"));
    const gateway: StitchGateway = {
      createProject: vi.fn().mockResolvedValue("p2"),
      generate,
      listScreens: vi.fn().mockResolvedValue([]),
    };
    await expect(runStitchPromptExperiment({ outputDir, prompt, title: "test", gateway })).rejects.toThrow(/Stitch unavailable/);
    expect(generate).toHaveBeenCalledOnce();
    const result = JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8"));
    expect(result).toMatchObject({ projectId: "p2", status: "FAILED", error: "Stitch unavailable" });
  });

  it("treats an edit response without a screen as a failed experiment", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "monarch-reference-empty-"));
    const editScreen = vi.fn().mockResolvedValue([]);
    const gateway: StitchGateway = {
      createProject: vi.fn().mockResolvedValue("p4"),
      ensureHomeFrameworkReference: vi.fn().mockResolvedValue("reference-4"),
      editScreen,
      generate: vi.fn(),
      listScreens: vi.fn().mockResolvedValue([]),
    };
    await expect(runStitchPromptExperiment({
      outputDir,
      prompt,
      referenceImagePath: "/example/med-spa-reference.png",
      title: "empty edit",
      gateway,
    })).rejects.toThrow(/no screen resources/);
    expect(editScreen).toHaveBeenCalledOnce();
    expect(gateway.generate).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8"))).toMatchObject({
      projectId: "p4",
      referenceScreenId: "reference-4",
      status: "FAILED",
    });
  });
});

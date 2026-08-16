import assert from "node:assert/strict";
import test from "node:test";
import { runRpcAskFlow } from "../src/rpc/controller.ts";
import { createInitialState } from "../src/state/create.ts";
import type { AskParams } from "../src/types.ts";

interface SelectCall {
	options: string[];
	title: string;
}

type SelectResponse =
	| string
	| undefined
	| ((call: SelectCall) => string | undefined);

class RpcDialogHarness {
	readonly editorCalls: Array<{ prefill?: string; title: string }> = [];
	readonly inputCalls: Array<{ placeholder?: string; title: string }> = [];
	readonly selectCalls: SelectCall[] = [];
	private readonly editorResponses: Array<string | undefined>;
	private readonly inputResponses: Array<string | undefined>;
	private readonly selectResponses: SelectResponse[];

	constructor(
		selectResponses: SelectResponse[],
		inputResponses: Array<string | undefined> = [],
		editorResponses: Array<string | undefined> = []
	) {
		this.selectResponses = selectResponses;
		this.inputResponses = inputResponses;
		this.editorResponses = editorResponses;
	}

	readonly ctx = {
		ui: {
			editor: (title: string, prefill?: string) => {
				this.editorCalls.push({ title, prefill });
				return Promise.resolve(
					this.shiftResponse(this.editorResponses, "editor")
				);
			},
			input: (title: string, placeholder?: string) => {
				this.inputCalls.push({ title, placeholder });
				return Promise.resolve(
					this.shiftResponse(this.inputResponses, "input")
				);
			},
			select: (title: string, options: string[]) => {
				const call = { title, options };
				this.selectCalls.push(call);
				const response = this.shiftResponse(this.selectResponses, "select");
				return Promise.resolve(
					typeof response === "function" ? response(call) : response
				);
			},
		},
	};

	assertDrained(): void {
		assert.equal(this.selectResponses.length, 0, "unused select responses");
		assert.equal(this.inputResponses.length, 0, "unused input responses");
		assert.equal(this.editorResponses.length, 0, "unused editor responses");
	}

	private shiftResponse<T>(responses: T[], method: string): T {
		assert.notEqual(responses.length, 0, `unexpected ${method} dialog`);
		return responses.shift() as T;
	}
}

function pickOption(fragment: string): SelectResponse {
	return ({ options }) => {
		const option = options.find((candidate) => candidate.includes(fragment));
		assert(option, `missing option containing ${JSON.stringify(fragment)}`);
		return option;
	};
}

function params(questions: AskParams["questions"]): AskParams {
	return { title: "RPC interview", questions };
}

test("RPC single choice flattens descriptions and preview text", async () => {
	const harness = new RpcDialogHarness([pickOption("1. Compact"), "Continue"]);
	const state = createInitialState(
		params([
			{
				id: "layout",
				label: "Layout",
				prompt: "Which layout?",
				type: "preview",
				options: [
					{
						value: "compact",
						label: "Compact",
						description: "Dense controls",
						preview: "Line one\nLine two",
					},
				],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers.layout, {
		values: ["compact"],
		labels: ["Compact"],
		indices: [1],
		customText: undefined,
		note: undefined,
		optionNotes: undefined,
	});
	assert((harness.selectCalls[0]?.title ?? "").startsWith("[1/1]"));
	assert(
		harness.selectCalls[0]?.options.some(
			(option) =>
				option === "1. Compact — Dense controls — Preview: Line one Line two"
		)
	);
	harness.assertDrained();
});

test("RPC free-form input and a subsequent short note preserve normalization", async () => {
	const harness = new RpcDialogHarness(
		[pickOption("short answer"), pickOption("short question note"), "Continue"],
		["A custom answer", "Keep this concise"]
	);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "What is the goal?",
				options: [{ value: "speed", label: "Speed" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.deepEqual(result.answers.goal, {
		values: ["A custom answer"],
		labels: ["A custom answer"],
		indices: [],
		customText: "A custom answer",
		note: "Keep this concise",
		optionNotes: undefined,
	});
	assert((harness.inputCalls[0]?.title ?? "").endsWith("Short answer"));
	assert((harness.inputCalls[1]?.title ?? "").endsWith("Question note"));
	harness.assertDrained();
});

test("RPC multiline answers and notes use editor dialogs", async () => {
	const harness = new RpcDialogHarness(
		[
			pickOption("multiline answer"),
			pickOption("multiline question note"),
			"Continue",
		],
		[],
		["First line\nSecond line", "Detailed\ncontext"]
	);
	const state = createInitialState(
		params([
			{
				id: "details",
				prompt: "Add details",
				options: [{ value: "default", label: "Use defaults" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.answers.details?.customText, "First line\nSecond line");
	assert.equal(result.answers.details?.note, "Detailed\ncontext");
	assert.deepEqual(
		harness.editorCalls.map((call) => call.prefill),
		["", ""]
	);
	harness.assertDrained();
});

test("RPC dialog dismissal cancels the flow", async () => {
	const harness = new RpcDialogHarness([undefined]);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "Choose",
				options: [{ value: "speed", label: "Speed" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, true);
	assert.deepEqual(result.answers, {});
	harness.assertDrained();
});

test("RPC input dismissal also cancels instead of recording an empty answer", async () => {
	const harness = new RpcDialogHarness(
		[pickOption("short answer")],
		[undefined]
	);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "Choose",
				options: [{ value: "speed", label: "Speed" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, true);
	assert.deepEqual(result.answers, {});
	harness.assertDrained();
});

test("RPC optional skip and multiple questions run sequentially with progress", async () => {
	const harness = new RpcDialogHarness([
		pickOption("Skip this question (optional)"),
		"Continue",
		pickOption("1. Direct"),
		"Continue",
	]);
	const state = createInitialState(
		params([
			{
				id: "scope",
				label: "Scope",
				prompt: "Pick scope",
				options: [{ value: "small", label: "Small" }],
			},
			{
				id: "tone",
				label: "Tone",
				prompt: "Pick tone",
				required: true,
				options: [{ value: "direct", label: "Direct" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.answers.scope, undefined);
	assert.deepEqual(result.answers.tone?.values, ["direct"]);
	assert((harness.selectCalls[0]?.title ?? "").startsWith("[1/2]"));
	assert((harness.selectCalls[2]?.title ?? "").startsWith("[2/2]"));
	harness.assertDrained();
});

test("RPC multi-select loops with selected markers and explicit finish", async () => {
	const harness = new RpcDialogHarness(
		[
			pickOption("[ ] 2. Beta"),
			(call) => {
				assert(call.options.includes("[x] 2. Beta — Second"));
				return call.options.find((option) => option.includes("[ ] 1. Alpha"));
			},
			(call) => {
				assert(call.options.includes("[x] 1. Alpha — First"));
				assert(call.options.includes("[x] 2. Beta — Second"));
				assert(call.options.includes("Finish selection"));
				return "Finish selection";
			},
			pickOption("note for selected option: Alpha"),
			"Continue",
		],
		[],
		["Prefer this first"]
	);
	const state = createInitialState(
		params([
			{
				id: "features",
				prompt: "Which features?",
				type: "multi",
				options: [
					{ value: "alpha", label: "Alpha", description: "First" },
					{ value: "beta", label: "Beta", description: "Second" },
				],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.deepEqual(result.answers.features, {
		values: ["alpha", "beta"],
		labels: ["Alpha", "Beta"],
		indices: [1, 2],
		customText: undefined,
		note: undefined,
		optionNotes: { alpha: "Prefer this first" },
	});
	harness.assertDrained();
});

test("RPC yes/no uses cancellable select options and preserves metadata", async () => {
	const harness = new RpcDialogHarness([pickOption("2. No"), "Continue"]);
	const state = createInitialState(
		params([
			{
				id: "proceed",
				prompt: "Proceed?",
				options: [
					{ value: "yes", label: "Yes", description: "Continue now" },
					{ value: "no", label: "No", description: "Stop here" },
				],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.deepEqual(result.answers.proceed?.values, ["no"]);
	assert.deepEqual(result.answers.proceed?.labels, ["No"]);
	assert.deepEqual(result.answers.proceed?.indices, [2]);
	assert(harness.selectCalls[0]?.options.includes("1. Yes — Continue now"));
	assert(harness.selectCalls[0]?.options.includes("2. No — Stop here"));
	harness.assertDrained();
});

test("RPC yes/no can be cancelled without being recorded as No", async () => {
	const harness = new RpcDialogHarness([pickOption("Cancel ask")]);
	const state = createInitialState(
		params([
			{
				id: "proceed",
				prompt: "Proceed?",
				options: [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, true);
	assert.deepEqual(result.answers, {});
	harness.assertDrained();
});

test("RPC presentation overrides keep normalized requested and presented types", async () => {
	const harness = new RpcDialogHarness([
		pickOption("[ ] 1. Stable"),
		"Finish selection",
		"Continue",
	]);
	const state = createInitialState(
		params([
			{
				id: "api",
				prompt: "Choose API",
				type: "single",
				options: [{ value: "stable", label: "Stable" }],
			},
		]),
		{ presentSingleAsMulti: true }
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.deepEqual(result.questions, [
		{
			id: "api",
			label: "Q1",
			prompt: "Choose API",
			type: "single",
			presentedType: "multi",
		},
	]);
	assert.deepEqual(result.answers.api?.values, ["stable"]);
	harness.assertDrained();
});

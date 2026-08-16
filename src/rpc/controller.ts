import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	emptyAnswer,
	isAnswerEmpty,
	isOptionSelected,
	saveCustomText,
	saveOptionNote,
	saveQuestionNote,
	setSingleSelection,
	toggleSelection,
} from "../state/answers.ts";
import { toAskResult } from "../state/result.ts";
import type {
	AskDisplayOption,
	AskQuestion,
	AskResult,
	AskState,
	AskStateAnswer,
} from "../types.ts";

type RpcUi = Pick<ExtensionContext["ui"], "editor" | "input" | "select">;

interface RpcFlowOptions {
	signal?: AbortSignal;
}

type RpcCompletionResult =
	| { kind: "cancelled"; state: AskState }
	| { kind: "completed"; state: AskState };

type RpcActionResult = RpcCompletionResult | { kind: "back"; state: AskState };

type RpcEditResult =
	| { kind: "back"; state: AskState }
	| { kind: "cancelled"; state: AskState }
	| { kind: "saved"; state: AskState };

interface SelectAction {
	kind:
		| "cancel"
		| "custom-editor"
		| "custom-input"
		| "finish"
		| "option"
		| "skip";
	label: string;
	optionIndex?: number;
}

interface NoteAction {
	kind:
		| "cancel"
		| "continue"
		| "option-note"
		| "question-editor"
		| "question-input";
	label: string;
	optionValue?: string;
}

const CANCEL_LABEL = "Cancel ask";
const CONTINUE_LABEL = "Continue";
const CUSTOM_EDITOR_LABEL = "Write or edit a multiline answer…";
const CUSTOM_INPUT_LABEL = "Type or edit a short answer…";
const FINISH_SELECTION_LABEL = "Finish selection";

export async function runRpcAskFlow(
	ctx: { ui: RpcUi },
	initialState: AskState,
	options: RpcFlowOptions = {}
): Promise<AskResult> {
	let state = initialState;

	for (const [questionIndex] of state.questions.entries()) {
		if (options.signal?.aborted) {
			return cancelledResult(state);
		}
		const answerStep = await askQuestion(
			ctx.ui,
			state,
			questionIndex,
			options.signal
		);
		state = answerStep.state;
		if (answerStep.kind === "cancelled") {
			return cancelledResult(state);
		}

		const noteStep = await askForOptionalNotes(
			ctx.ui,
			state,
			questionIndex,
			options.signal
		);
		state = noteStep.state;
		if (noteStep.kind === "cancelled") {
			return cancelledResult(state);
		}
	}
	if (options.signal?.aborted) {
		return cancelledResult(state);
	}

	return toAskResult({
		...state,
		activeTabIndex: state.questions.length,
		completed: true,
	});
}

async function askQuestion(
	ui: RpcUi,
	state: AskState,
	questionIndex: number,
	signal?: AbortSignal
): Promise<RpcCompletionResult> {
	const question = state.questions[questionIndex];
	if (!question) {
		return { kind: "completed", state };
	}
	if (question.type === "multi") {
		return await askMultiQuestion(ui, state, question, questionIndex, signal);
	}
	return await askSingleQuestion(ui, state, question, questionIndex, signal);
}

async function askSingleQuestion(
	ui: RpcUi,
	initialState: AskState,
	question: AskQuestion,
	questionIndex: number,
	signal?: AbortSignal
): Promise<RpcCompletionResult> {
	let state = initialState;
	while (true) {
		if (signal?.aborted) {
			return { kind: "cancelled", state };
		}
		const actions: SelectAction[] = [...question.options.entries()]
			.filter(([, option]) => !option.freeform)
			.map(([optionIndex, option]) => ({
				kind: "option" as const,
				label: formatOption(option, optionIndex),
				optionIndex,
			}));
		appendCommonActions(actions, question);

		const action = await selectAction(
			ui,
			formatTitle(state, question, questionIndex),
			actions,
			signal
		);
		const result = await applySingleAction({
			action,
			question,
			questionIndex,
			signal,
			state,
			ui,
		});
		if (result.kind !== "back") {
			return result;
		}
		state = result.state;
	}
}

async function applySingleAction(args: {
	action: SelectAction | undefined;
	question: AskQuestion;
	questionIndex: number;
	signal?: AbortSignal;
	state: AskState;
	ui: RpcUi;
}): Promise<RpcActionResult> {
	const { action, question, questionIndex, signal, state, ui } = args;
	if (!action || action.kind === "cancel") {
		return { kind: "cancelled", state };
	}
	if (action.kind === "skip") {
		return {
			kind: "completed",
			state: clearAnswer(state, question.id),
		};
	}
	if (action.kind === "custom-input" || action.kind === "custom-editor") {
		const editResult = await askForCustomAnswer(
			ui,
			state,
			question,
			questionIndex,
			action.kind === "custom-editor",
			signal
		);
		return editResult.kind === "saved"
			? { kind: "completed", state: editResult.state }
			: editResult;
	}
	if (action.kind !== "option") {
		return { kind: "cancelled", state };
	}

	return selectSingleOption(state, question, action.optionIndex);
}

function selectSingleOption(
	state: AskState,
	question: AskQuestion,
	optionIndex: number | undefined
): RpcCompletionResult {
	const option =
		optionIndex === undefined ? undefined : question.options[optionIndex];
	if (!option || optionIndex === undefined) {
		return { kind: "cancelled", state };
	}
	return {
		kind: "completed",
		state: updateAnswer(state, question.id, (answer) =>
			setSingleSelection(answer, option, optionIndex)
		),
	};
}

async function askMultiQuestion(
	ui: RpcUi,
	initialState: AskState,
	question: AskQuestion,
	questionIndex: number,
	signal?: AbortSignal
): Promise<RpcCompletionResult> {
	let state = initialState;
	while (true) {
		if (signal?.aborted) {
			return { kind: "cancelled", state };
		}
		const actions = createMultiActions(question, state.answers[question.id]);
		const action = await selectAction(
			ui,
			formatTitle(state, question, questionIndex, "Select all that apply"),
			actions,
			signal
		);
		const actionResult = await applyMultiAction({
			action,
			question,
			questionIndex,
			signal,
			state,
			ui,
		});
		if (actionResult.kind !== "back") {
			return actionResult;
		}
		state = actionResult.state;
	}
}

function createMultiActions(
	question: AskQuestion,
	answer: AskStateAnswer | undefined
): SelectAction[] {
	const actions: SelectAction[] = [...question.options.entries()]
		.filter(([, option]) => !option.freeform)
		.map(([optionIndex, option]) => ({
			kind: "option" as const,
			label: formatOption(option, optionIndex, {
				selected: isOptionSelected(answer, option.value),
			}),
			optionIndex,
		}));
	actions.push({ kind: "finish", label: FINISH_SELECTION_LABEL });
	actions.push({
		kind: "custom-input",
		label: formatCustomAction(CUSTOM_INPUT_LABEL, answer),
	});
	actions.push({
		kind: "custom-editor",
		label: formatCustomAction(CUSTOM_EDITOR_LABEL, answer),
	});
	actions.push({ kind: "skip", label: formatSkipLabel(question) });
	actions.push({ kind: "cancel", label: CANCEL_LABEL });
	return actions;
}

async function applyMultiAction(args: {
	action: SelectAction | undefined;
	question: AskQuestion;
	questionIndex: number;
	signal?: AbortSignal;
	state: AskState;
	ui: RpcUi;
}): Promise<RpcActionResult> {
	const { action, question, questionIndex, signal, state, ui } = args;
	if (!action || action.kind === "cancel") {
		return { kind: "cancelled", state };
	}
	if (action.kind === "finish") {
		return { kind: "completed", state };
	}
	if (action.kind === "skip") {
		return {
			kind: "completed",
			state: clearAnswer(state, question.id),
		};
	}
	if (action.kind === "custom-input" || action.kind === "custom-editor") {
		const editResult = await askForCustomAnswer(
			ui,
			state,
			question,
			questionIndex,
			action.kind === "custom-editor",
			signal
		);
		return editResult.kind === "cancelled"
			? editResult
			: { kind: "back", state: editResult.state };
	}
	return applyMultiOptionAction(state, question, action);
}

function applyMultiOptionAction(
	state: AskState,
	question: AskQuestion,
	action: SelectAction
): RpcActionResult {
	const optionIndex = action.optionIndex;
	const option =
		optionIndex === undefined ? undefined : question.options[optionIndex];
	if (!option || optionIndex === undefined) {
		return { kind: "cancelled", state };
	}
	return {
		kind: "back",
		state: updateAnswer(state, question.id, (currentAnswer) =>
			toggleSelection(currentAnswer, option, optionIndex)
		),
	};
}

async function askForCustomAnswer(
	ui: RpcUi,
	state: AskState,
	question: AskQuestion,
	questionIndex: number,
	multiline: boolean,
	signal?: AbortSignal
): Promise<RpcEditResult> {
	if (signal?.aborted) {
		return { kind: "cancelled", state };
	}
	const currentText = state.answers[question.id]?.customText;
	const title = formatTitle(
		state,
		question,
		questionIndex,
		multiline ? "Multiline answer" : "Short answer"
	);
	const value = multiline
		? await ui.editor(title, currentText ?? "")
		: await ui.input(title, formatInputPlaceholder(currentText), { signal });
	if (signal?.aborted) {
		return { kind: "cancelled", state };
	}
	if (value === undefined) {
		return { kind: "back", state };
	}

	return {
		kind: "saved",
		state: updateAnswer(state, question.id, (answer) =>
			saveCustomText(
				answer,
				value,
				question.type === "multi" ? "multi" : "single"
			)
		),
	};
}

async function askForOptionalNotes(
	ui: RpcUi,
	initialState: AskState,
	questionIndex: number,
	signal?: AbortSignal
): Promise<RpcCompletionResult> {
	let state = initialState;
	const question = state.questions[questionIndex];
	if (!question) {
		return { kind: "completed", state };
	}

	while (true) {
		if (signal?.aborted) {
			return { kind: "cancelled", state };
		}
		const answer = state.answers[question.id];
		const actions = createNoteActions(answer);
		const action = await selectNoteAction(
			ui,
			formatTitle(state, question, questionIndex, "Optional notes"),
			actions,
			signal
		);
		const actionResult = await applyNoteAction({
			action,
			question,
			questionIndex,
			signal,
			state,
			ui,
		});
		if (actionResult.kind !== "back") {
			return actionResult;
		}
		state = actionResult.state;
	}
}

function appendCommonActions(
	actions: SelectAction[],
	question: AskQuestion
): void {
	actions.push({ kind: "custom-input", label: CUSTOM_INPUT_LABEL });
	actions.push({ kind: "custom-editor", label: CUSTOM_EDITOR_LABEL });
	actions.push({ kind: "skip", label: formatSkipLabel(question) });
	actions.push({ kind: "cancel", label: CANCEL_LABEL });
}

function createNoteActions(answer: AskStateAnswer | undefined): NoteAction[] {
	return [
		{ kind: "continue", label: CONTINUE_LABEL },
		{
			kind: "question-input",
			label: answer?.note
				? "Replace or clear the short question note…"
				: "Add a short question note…",
		},
		{
			kind: "question-editor",
			label: answer?.note
				? "Edit the question note in a multiline editor…"
				: "Add a multiline question note…",
		},
		...(answer?.selected ?? []).map((selection) => ({
			kind: "option-note" as const,
			optionValue: selection.value,
			label: answer?.optionNotes?.[selection.value]
				? `Edit note for selected option: ${selection.index}. ${compactText(selection.label)}…`
				: `Add note for selected option: ${selection.index}. ${compactText(selection.label)}…`,
		})),
		{ kind: "cancel", label: CANCEL_LABEL },
	];
}

async function applyNoteAction(args: {
	action: NoteAction | undefined;
	question: AskQuestion;
	questionIndex: number;
	signal?: AbortSignal;
	state: AskState;
	ui: RpcUi;
}): Promise<RpcActionResult> {
	const { action, question, questionIndex, signal, state, ui } = args;
	if (!action || action.kind === "cancel") {
		return { kind: "cancelled", state };
	}
	if (action.kind === "continue") {
		return { kind: "completed", state };
	}
	if (action.kind === "question-input") {
		return noteEditActionResult(
			await editQuestionNote(ui, state, question, questionIndex, false, signal)
		);
	}
	if (action.kind === "question-editor") {
		return noteEditActionResult(
			await editQuestionNote(ui, state, question, questionIndex, true, signal)
		);
	}
	return noteEditActionResult(
		await editOptionNote(ui, state, question, questionIndex, action, signal)
	);
}

function noteEditActionResult(result: RpcEditResult): RpcActionResult {
	return result.kind === "cancelled"
		? result
		: { kind: "back", state: result.state };
}

async function editQuestionNote(
	ui: RpcUi,
	state: AskState,
	question: AskQuestion,
	questionIndex: number,
	multiline: boolean,
	signal?: AbortSignal
): Promise<RpcEditResult> {
	if (signal?.aborted) {
		return { kind: "cancelled", state };
	}
	const currentNote = state.answers[question.id]?.note;
	const title = formatTitle(state, question, questionIndex, "Question note");
	const value = multiline
		? await ui.editor(title, currentNote ?? "")
		: await ui.input(title, formatNotePlaceholder(currentNote), { signal });
	if (signal?.aborted) {
		return { kind: "cancelled", state };
	}
	if (value === undefined) {
		return { kind: "back", state };
	}
	return {
		kind: "saved",
		state: updateAnswer(state, question.id, (answer) =>
			saveQuestionNote(answer, value)
		),
	};
}

async function editOptionNote(
	ui: RpcUi,
	state: AskState,
	question: AskQuestion,
	questionIndex: number,
	action: NoteAction,
	signal?: AbortSignal
): Promise<RpcEditResult> {
	if (signal?.aborted) {
		return { kind: "cancelled", state };
	}
	const optionValue = action.optionValue;
	const option = question.options.find(
		(candidate) => candidate.value === optionValue
	);
	if (!(optionValue && option)) {
		return { kind: "cancelled", state };
	}
	const value = await ui.editor(
		formatTitle(
			state,
			question,
			questionIndex,
			`Note for ${compactText(option.label)}`
		),
		state.answers[question.id]?.optionNotes?.[optionValue] ?? ""
	);
	if (signal?.aborted) {
		return { kind: "cancelled", state };
	}
	if (value === undefined) {
		return { kind: "back", state };
	}
	return {
		kind: "saved",
		state: updateAnswer(state, question.id, (answer) =>
			saveOptionNote(answer, optionValue, value)
		),
	};
}

async function selectAction(
	ui: RpcUi,
	title: string,
	actions: SelectAction[],
	signal?: AbortSignal
): Promise<SelectAction | undefined> {
	if (signal?.aborted) {
		return;
	}
	const selected = await ui.select(
		title,
		actions.map((action) => action.label),
		{ signal }
	);
	if (signal?.aborted) {
		return;
	}
	return actions.find((action) => action.label === selected);
}

async function selectNoteAction(
	ui: RpcUi,
	title: string,
	actions: NoteAction[],
	signal?: AbortSignal
): Promise<NoteAction | undefined> {
	if (signal?.aborted) {
		return;
	}
	const selected = await ui.select(
		title,
		actions.map((action) => action.label),
		{ signal }
	);
	if (signal?.aborted) {
		return;
	}
	return actions.find((action) => action.label === selected);
}

function updateAnswer(
	state: AskState,
	questionId: string,
	mutate: (answer: AskStateAnswer) => AskStateAnswer
): AskState {
	const nextAnswer = mutate(state.answers[questionId] ?? emptyAnswer());
	const answers = { ...state.answers };
	if (isAnswerEmpty(nextAnswer)) {
		delete answers[questionId];
	} else {
		answers[questionId] = nextAnswer;
	}
	return { ...state, answers };
}

function clearAnswer(state: AskState, questionId: string): AskState {
	if (!state.answers[questionId]) {
		return state;
	}
	const answers = { ...state.answers };
	delete answers[questionId];
	return { ...state, answers };
}

function cancelledResult(state: AskState): AskResult {
	return toAskResult({
		...state,
		cancelled: true,
		completed: true,
	});
}

function formatTitle(
	state: AskState,
	question: AskQuestion,
	questionIndex: number,
	suffix?: string
): string {
	const progress = `[${questionIndex + 1}/${state.questions.length}]`;
	const flowTitle = state.title ? `${compactText(state.title)} — ` : "";
	const detail = suffix ? ` — ${suffix}` : "";
	return `${progress} ${flowTitle}${compactText(question.label)}: ${compactText(question.prompt)}${detail}`;
}

function formatOption(
	option: AskDisplayOption,
	optionIndex: number,
	options: { selected?: boolean } = {}
): string {
	let marker = "";
	if (options.selected !== undefined) {
		marker = options.selected ? "[x] " : "[ ] ";
	}
	const description = option.description
		? ` — ${compactText(option.description)}`
		: "";
	const preview = option.preview
		? ` — Preview: ${compactText(option.preview)}`
		: "";
	return `${marker}${optionIndex + 1}. ${compactText(option.label)}${description}${preview}`;
}

function formatCustomAction(
	baseLabel: string,
	answer: AskStateAnswer | undefined
): string {
	if (!(answer?.customSelected && answer.customText?.trim())) {
		return `[ ] ${baseLabel}`;
	}
	return `[x] ${baseLabel} — Current: ${truncateText(answer.customText)}`;
}

function formatSkipLabel(question: AskQuestion): string {
	return question.required
		? "Skip this question (required is advisory)"
		: "Skip this question (optional)";
}

function formatInputPlaceholder(currentText: string | undefined): string {
	return currentText?.trim()
		? `Current: ${truncateText(currentText)}. Enter a replacement or leave blank to clear.`
		: "Enter a short free-form answer";
}

function formatNotePlaceholder(currentNote: string | undefined): string {
	return currentNote?.trim()
		? `Current: ${truncateText(currentNote)}. Enter a replacement or leave blank to clear.`
		: "Add an optional note or comment";
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string): string {
	const compact = compactText(value);
	return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

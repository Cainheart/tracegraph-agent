import type { TodoItem, TodoState } from "@tracegraph/contracts";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

const TODO_STATES: readonly TodoState[] = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

export function TodoPanel({
  todos,
  busyTodoId,
  disabled = false,
  disabledReason,
  error,
  onStateChange,
  onSelectEvidence,
}: {
  todos: readonly TodoItem[];
  busyTodoId?: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
  error?: string | null;
  onStateChange: (todo: TodoItem, state: TodoState) => void;
  onSelectEvidence: (eventId: string) => void;
}) {
  const { t } = useI18n();
  const byId = new Map(todos.map((todo) => [todo.todo_id, todo]));
  const completeCount = todos.filter(({ state }) => state === "done").length;

  return (
    <section className="todo-panel" aria-label={t("Run Todo list")}>
      <header className="todo-panel-heading">
        <div>
          <span className="eyebrow">{t("Execution plan")}</span>
          <h3>{t("Todo list")}</h3>
        </div>
        <span className="todo-progress">{completeCount} / {todos.length} {t("done")}</span>
      </header>

      {error && <p className="todo-error" role="alert"><Icon name="alert" size={12} />{error}</p>}
      {!error && disabledReason && <p className="todo-disabled-note" role="status"><Icon name="shield" size={12} />{disabledReason}</p>}

      {todos.length === 0 ? (
        <p className="todo-empty">{t("No Todo items have been recorded for this Run.")}</p>
      ) : (
        <ol className="todo-list">
          {todos.map((todo) => {
            const busy = busyTodoId === todo.todo_id;
            return (
              <li className={`todo-item todo-${todo.state}`} key={todo.todo_id}>
                <label className="todo-check">
                  <input
                    aria-label={`${t("Mark Todo done")}: ${todo.title}`}
                    checked={todo.state === "done"}
                    disabled={disabled || busy}
                    onChange={(event) => onStateChange(todo, event.target.checked ? "done" : "pending")}
                    type="checkbox"
                  />
                  <span aria-hidden="true"><Icon name="check" size={12} /></span>
                </label>
                <div className="todo-copy">
                  <div className="todo-title-line">
                    <strong>{todo.title}</strong>
                    <span className={`todo-state todo-state-${todo.state}`}>{t(todo.state)}</span>
                    <small>{t(todo.created_by === "model" ? "Model created" : "User created")}</small>
                  </div>
                  {todo.detail && <p>{todo.detail}</p>}
                  {todo.depends_on.length > 0 && (
                    <div className="todo-relations">
                      <span>{t("Depends on")}</span>
                      {todo.depends_on.map((todoId) => (
                        <code key={todoId} title={todoId}>
                          {byId.get(todoId)?.title ?? todoId}
                        </code>
                      ))}
                    </div>
                  )}
                  {todo.evidence_event_ids.length > 0 && (
                    <div className="todo-relations todo-evidence">
                      <span>{t("Evidence")}</span>
                      {todo.evidence_event_ids.map((eventId) => (
                        <button key={eventId} onClick={() => onSelectEvidence(eventId)} type="button">
                          <Icon name="external" size={11} />#{eventId}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <label className="todo-state-picker">
                  <span>{t("State")}</span>
                  <select
                    aria-label={`${t("Todo state")}: ${todo.title}`}
                    disabled={disabled || busy}
                    onChange={(event) => onStateChange(todo, event.target.value as TodoState)}
                    value={todo.state}
                  >
                    {TODO_STATES.map((state) => <option key={state} value={state}>{t(state)}</option>)}
                  </select>
                </label>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

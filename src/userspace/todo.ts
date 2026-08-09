import { procHash } from "../hash.ts";

export const TODO_MANAGE_CAPABILITY = "todo:manage";

/** A private todo list owned by each signed account. */
export const TODO_REDUCER_CODE = `let authorization = ctx.authorization;
if (authorization == null) throw "Authorization required";
let allowed = false;
for (let i = 0; i < authorization.capabilities.length; i += 1) {
  if (authorization.capabilities[Number(i)] == "${TODO_MANAGE_CAPABILITY}") allowed = true;
}
if (!allowed) throw "Missing todo:manage capability";
let key = "todos:" + authorization.account;
let todos = ctx.state.private.get(key) || [];
if (input.action == "list") return todos;
if (input.action == "add") {
  if (typeof input.id != "string" || typeof input.text != "string") throw "Invalid todo";
  if (input.id.length < 1 || input.id.length > 100 || input.text.length < 1 || input.text.length > 200) throw "Invalid todo";
  if (todos.length >= 100) throw "Todo limit reached";
  for (let i = 0; i < todos.length; i += 1) if (todos[Number(i)].id == input.id) throw "Todo already exists";
  todos[Number(todos.length)] = { id: input.id, text: input.text, done: false };
  ctx.state.private.set(key, todos);
  return todos;
}
if (input.action == "toggle") {
  if (typeof input.id != "string") throw "Invalid todo";
  let found = false;
  for (let i = 0; i < todos.length; i += 1) {
    let todo = todos[Number(i)];
    if (todo.id == input.id) {
      todos[Number(i)] = { id: todo.id, text: todo.text, done: !todo.done };
      found = true;
    }
  }
  if (!found) throw "Todo not found";
  ctx.state.private.set(key, todos);
  return todos;
}
if (input.action == "remove") {
  if (typeof input.id != "string") throw "Invalid todo";
  let next = [];
  for (let i = 0; i < todos.length; i += 1) {
    let todo = todos[Number(i)];
    if (todo.id != input.id) next[Number(next.length)] = todo;
  }
  if (next.length == todos.length) throw "Todo not found";
  if (next.length == 0) ctx.state.private.delete(key);
  else ctx.state.private.set(key, next);
  return next;
}
throw "Unknown todo action";`;

export const TODO_REDUCER_HASH = procHash(TODO_REDUCER_CODE);

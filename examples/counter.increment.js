return ctx.atomic(function increment(tx) {
  let count = tx.state.public.get("count") || 0;
  tx.state.public.set("count", count + 1);
  return count + 1;
});

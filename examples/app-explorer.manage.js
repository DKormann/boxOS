if (!input || !input.grant || input.grant.domain != "boxos-grant/0.3.0" ||
    input.grant.permission != "apps" || input.grant.subject != ctx.rootCaller ||
    input.grant.account != input.account) {
  throw "Invalid app-management grant";
}
let valid = await ctx.verify(input.account, input.grant, input.signature);
if (!valid) throw "Invalid app-management grant signature";
if (input.action != "publish" && input.action != "unpublish" && input.action != "install" && input.action != "uninstall") {
  throw "Unknown app action";
}
return ctx.atomic(function manage(tx) {
  let apps = tx.state.public.get("apps") || [];
  let installedKey = "installed:" + input.account;
  let installed = tx.state.public.get(installedKey) || [];
  let nextApps = [];
  let nextInstalled = [];
  let publishedFound = false;
  let installedFound = false;
  let i = 0;
  while (i < apps.length) {
    let app = apps[Number(i)];
    if (app.id == input.app.id) {
      publishedFound = true;
      if (input.action == "unpublish") {
        if (app.publisher != input.account) throw "Only the publisher can unpublish this app";
      } else {
        nextApps.push(app);
      }
    } else {
      nextApps.push(app);
    }
    i = i + 1;
  }
  i = 0;
  while (i < installed.length) {
    let id = installed[Number(i)];
    if (id == input.app.id) installedFound = true;
    if (!(id == input.app.id && input.action == "uninstall")) nextInstalled.push(id);
    i = i + 1;
  }
  if (input.action == "publish") {
    if (typeof input.app.id != "string" || typeof input.app.name != "string" || typeof input.app.url != "string" ||
        input.app.id.length < 1 || input.app.id.length > 128 || input.app.name.length < 1 || input.app.name.length > 80 ||
        input.app.url.length < 1 || input.app.url.length > 2048 || typeof input.app.description != "string" || input.app.description.length > 300) {
      throw "Invalid app details";
    }
    if (publishedFound) throw "An app with this ID is already published";
    nextApps.push({ id: input.app.id, name: input.app.name, url: input.app.url, description: input.app.description, publisher: input.account });
    tx.state.public.set("apps", nextApps);
  } else if (input.action == "unpublish") {
    if (!publishedFound) throw "App is not published";
    tx.state.public.set("apps", nextApps);
  } else if (input.action == "install") {
    if (!publishedFound) throw "App is not published";
    if (!installedFound) nextInstalled.push(input.app.id);
    tx.state.public.set(installedKey, nextInstalled);
  } else {
    tx.state.public.set(installedKey, nextInstalled);
  }
  return true;
});

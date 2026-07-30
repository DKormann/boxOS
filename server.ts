


const builder = (()=>{

  type Schema <T> = (x: any) => T

  type Infer<S extends Schema<any>> = S extends Schema<infer T> ? T : never

  const string: Schema<string> = (x: any) => {
    if (typeof x === "string") return x;
    throw new Error(`Expected string, got ${typeof x}`);
  }

  const number: Schema<number> = (x: any) => {
    if (typeof x === "number") return x;
    throw new Error(`Expected number, got ${typeof x}`);
  }

  const boolean: Schema<boolean> = (x: any) => {
    if (typeof x === "boolean") return x;
    throw new Error(`Expected boolean, got ${typeof x}`);
  }

  function record<T> (schema: Schema<T>): Schema<Record<string, T>> {
    return (x: any) => {
      if (typeof x !== "object" || x === null) {
        throw new Error(`Expected object, got ${typeof x}`);
      }
      const result: Record<string, T> = {};
      for (const key in x) {
        result[key] = schema(x[key]);
      }
      return result;
    }
  }

  function struct<T extends Record<string, Schema<any>>> (schemas: T): Schema<{ [K in keyof T]: Infer<T[K]> }> {
    return (x: any) => {
      if (typeof x !== "object" || x === null) {
        throw new Error(`Expected object, got ${typeof x}`);
      }
      const result: any = {};
      for (const key in schemas) {
        result[key] = schemas[key]!(x[key]);
      }
      return result;
    }
  }


  function constant <T extends string | number | boolean>(value: T): Schema<T> {
    return (x: any) => {
      if (x === value) return value;
      throw new Error(`Expected ${value}, got ${x}`);
    }
  }

  function union <T extends Schema<any>[]>(...schemas: T): Schema<Infer<T[number]>> {
    return (x: any) => {
      for (const schema of schemas) {
        try {
          return schema(x);
        } catch (e) {
          // ignore
        }
      }
      throw new Error(`Value does not match any schema`);
    }
  }

  return {
    string,
    number,
    boolean,
    record,
    struct,
    constant,
    union,
  }

})()




type PROC = {
  $: "proc",
  code: string,
}

function PROC_HASH (proc: PROC): string {
  return Bun.hash.adler32(proc.code).toString(16);
}


type PROC_CTX = {
  store: (key: string, value: string) => void,
  load: (key: string) => string,
  delete: (key: string) => void,
  has: (key: string) => boolean,
  hash: (proc: PROC) => string,
} & typeof builder


function invoke (proc: PROC, ctx: PROC_CTX, arg: string): string {
  try{
    const func = new Function("ctx", "arg" , proc.code);
    const result = func(ctx, arg);
    return JSON.stringify({ok: result});
  }catch (e){
    return JSON.stringify({error: String(e)});
  }
}


const funcs: PROC = {
  $: "proc",
  code: (
    function(c: PROC_CTX, arg: string) {

      let ARG = c.union(
        c.struct({register: c.string,}),
        c.struct({invoke: c.string, arg: c.string,}),
        c.struct({inspect: c.string}),
      )

      let dat = ARG(JSON.parse(arg));

      if ("register" in dat){
        let proc: PROC = {
          $: "proc",
          code: c.string(dat.register),
        }
        let hash = c.hash(proc);
        c.store(hash, proc.code);
        return hash;
      } if ("invoke" in dat){

        let hash = c.string(dat.invoke);

        if (!c.has(hash)) throw new Error(`No such proc: ${hash}`);

        let code = c.string(c.load(hash));
        let proc: PROC = {
          $: "proc",
          code,
        }

        let ctx : PROC_CTX = {
          ...c,
          store (k,v) {
            c.store(hash+":"+k,v);
          },
          load (k) {
            return c.load(hash+":"+k);
          },
          delete (k) {
            c.delete(hash+":"+k);
          },
          has (k) {
            return c.has(hash+":"+k);
          }
        }

        return invoke(proc, ctx, dat.arg);
      }else{
        return c.load(dat.inspect);
      }

    }
  ).toString()
}


const storage = new Map<string, string>();



Bun.serve({
  port: 4000,
  async fetch (req){
    let url = new URL(req.url);
    if (url.pathname === "/proc"){
      let body = await req.text();
      let ctx: PROC_CTX = {
        load (key) {
          let value = storage.get(key);
          if (value === undefined) throw new Error(`No such key: ${key}`);
          return value;
        },
        store (key, value) {
          storage.set(key, value);
        },
        delete (key) {
          storage.delete(key);
        },
        has (key) {
          return storage.has(key);
        },
        hash (proc) {
          return PROC_HASH(proc);
        },
        ...builder,
      }
      return new Response(JSON.stringify(invoke(funcs, ctx, body)), {status: 200});
    }else{
      return new Response("Not Found", {status: 404});
    }
  }
})

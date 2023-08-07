import * as ref from "ref-napi"
import { Callback } from "ffi-napi"
import type { Pointer } from "ref-napi"
import type { LibraryDefinitionBase, LibraryObjectDefinitionBase, LibraryObject, ForeignFunction } from "ffi-napi"
import * as repl from 'repl'
import * as util from 'util'

import {
  contextPtr, nix_err, nix_errs,
  libutil_fns, libutil_unwrapped,
  libstore_fns, libstore_unwrapped,
  rValueTypes, libexpr_fns, libexpr_unwrapped
} from "./lowlevel.js"



const pointer = Symbol("pointer");

// (ref as any).writePointer = function writePointer(buf: Buffer, offset: number, ptr: Buffer | { [pointer]: Buffer }) {
//   if (ptr && pointer in ptr) {
//     ptr = ptr[pointer]
//   }
//   (ref._writePointer as any)(buf, offset, ptr, true)
// }

function CWrapper(free_fn: (ptr: ref.TypeLike) => undefined) {
  const freer = new FinalizationRegistry(free_fn)
  return class Wrapper {
    [pointer]: Buffer
    constructor(ref: Buffer) {
      this[pointer] = ref
      freer.register(this, ref as any as ref.TypeLike)
    }
  }
}

const getContext = function() {
  const stack: Context[] = []
  let i = 0
  return function getContext<T>(fn: (ctx: Context) => T) : T {
    if (i >= stack.length) {
      stack.push(new Context())
    }
    const res = fn(stack[i++])
    i--
    return res
  }
}()
type Wrapped<Type extends LibraryDefinitionBase> = {
  [Property in keyof Type]: (...args: any) => any
}

function wrapLib<T extends LibraryDefinitionBase>(fns: LibraryObjectDefinitionBase, lib: LibraryObject<T>): Wrapped<T> {
  const wrapped: any = {}
  for (const [k, [rt, args]] of Object.entries(fns)) {
    const kv = k as keyof T
    if (args[0] == contextPtr)
            wrapped[kv] = (...args: any[]) => getContext(ctx => ctx.run(lib[kv] as any, ...args))
        else
            wrapped[kv] = lib[kv]
    Object.defineProperty(lib[kv], 'name', {
      value: kv,
      enumerable: true,
      configurable: true
    })
  }
  return wrapped
}


class Context extends CWrapper(libutil_unwrapped.nix_c_context_free) {
  constructor() {
    super(libutil_unwrapped.nix_c_context_create())
  }
  //run<T, A extends any[]>(fn: (ctx: ref.TypeLike, ...args: A) => T, ...args: A): T {
  run<T, A extends any[]>(fn: ForeignFunction<T, [any, ...A]>, ...args: A): T {
    const args2 = args.map(x => (typeof x == "object" || typeof x == "function") && x && pointer in x ? x[pointer] : x) as A
    const r = fn(this[pointer], ...args2)
    if (libutil_unwrapped.nix_err_code(this[pointer] as any as ref.TypeLike) != nix_errs.NIX_OK) {
      const msg = libutil.nix_err_msg(this, null)
      throw new Error("error occured: " + msg)
    }
    return r
  }
}
const libutil = wrapLib(libutil_fns, libutil_unwrapped)

console.log("nix version", libutil.nix_version_get())

libutil.nix_libutil_init()

const libstore = wrapLib(libstore_fns, libstore_unwrapped)
libstore.nix_libstore_init()

class StorePath extends CWrapper(libstore.nix_store_path_free) {
  store: Store
  constructor(store: Store, path: string) {
    super(libstore.nix_store_parse_path(store, path))
    this.store = store
  }
  isValid() {
    return libstore.nix_store_is_valid_path(this.store, this)
  }
  build() {
    const r: Record<string, string> = {}
    const cb = Callback('void', ['void*', 'string', 'string'], function(_userdata, outname, out) {
      r[outname] = out
    })
    libstore.nix_store_build(this.store, this, null, cb)
    return r
  }
}

class Store extends CWrapper(libstore.nix_store_unref) {
  constructor(url: string) {
    // todo args
    super(libstore.nix_store_open(url, null))
  }
  getURI(): string {
    const r = Buffer.alloc(128)
    libstore.nix_store_get_uri(this, r, 128)
    return r.readCString()
  }
  parsePath(path: string): StorePath {
    return new StorePath(this, path)
  }
  getVersion(): string {
    const r = Buffer.alloc(64)
    libstore.nix_store_get_version(this, r, 128)
    return r.readCString()
  }
}

const libexpr = wrapLib(libexpr_fns, libexpr_unwrapped)
libexpr.nix_libexpr_init()


type Convertible = Value<unknown> | boolean | number | string | bigint | Convertible[] | {
  [x: string]: Convertible
} | null
type DeepConverted = number | boolean | string | bigint | DeepConverted[] | {
  [x: string]: DeepConverted
} | ((...args: Convertible[]) => Value<unknown>) | null
type Converted = number | boolean | string | bigint | Value<unknown>[] | {
  [x: string]: Value<unknown>
} | ((...args: Convertible[]) => Value<unknown>) | null

class State extends CWrapper(libexpr.nix_state_free) {
  store: Store
  constructor(store: Store) {
    // todo searchPath
    super(libexpr.nix_state_create(null, store))
    this.store = store
  }
  allocValue(): Value<unknown> {
    const r = libexpr.nix_alloc_value(this)
    return new Value(this, r, false)
  }
  makeValue<T extends Convertible>(js_obj: T): Value<T> {
    const r: Value<unknown> = this.allocValue()
    r.set(js_obj)
    return r
  }
  eval(expr: string, path: string=""): Value<unknown> {
    const r = this.allocValue()
    libexpr.nix_expr_eval_from_string(this, expr, path, r)
    r.force()
    return r
  }
}

class BindingsBuilder extends CWrapper(libexpr.nix_bindings_builder_free) {
  constructor(state: State, sz: number) {
    super(libexpr.nix_make_bindings_builder(state, sz))
  }
  insert(key: string, val: Value<any>): void {
    libexpr.nix_bindings_builder_insert(this, key, val)
  }
}

const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
type TupleToUnion<T extends unknown[]> = T[number];

interface TypeRegistry_<deep> {
  thunk: never,
  int: number,
  float: number,
  bool: boolean,
  string: string,
  path: string,
  null: null,
  attrs: deep extends true ? {[x: string]: DeepConverted} : {[x: string]: Value<unknown>}
  list: (deep extends true ? DeepConverted : Converted)[],
  function: never,
  external: never
}
type TypeRegistry = TypeRegistry_<false>
type TypeRegistryDeep = TypeRegistry_<true>
type TypeKey = TypeRegistry extends TypeRegistry ? keyof TypeRegistry : never

class Value<V> extends CWrapper(libexpr.nix_gc_decref) {
  x?: V
  state: State
  constructor(state: State, ref: Pointer<unknown>, force: boolean=true) {
    super(ref)
    this.state = state
    if (force) this.force()
    const thizz = this
    // double wrapper, because I need something callable
    const thiz = (function Wrap(x: Convertible, ...args: Convertible[]): Value<unknown> { return (thizz as Value<"function" | "attrs">).call(x, ...args) })
    Object.setPrototypeOf(thiz, new.target.prototype)
    Object.assign(thiz, this)
    return new Proxy<Value<V>>(thiz as unknown as Value<V>, {
      get: function(target, prop, receiver) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver)
        } else {
          //console.log("getting", prop)
          if (typeof prop == 'symbol') return
          return target.lookup(prop)
        }
      },
      getOwnPropertyDescriptor(target, prop) {
        //console.log("getOwnPropDesc", prop)
        const op = Reflect.getOwnPropertyDescriptor(target, prop)
        if (op) return op
        if (typeof prop == 'symbol') return
        if (target.hasAttr(prop)) {
          return {
            configurable: true,
            enumerable: true,
            get: () => target.lookup(prop)
          }
        }
      },
      has(target, prop) {
        return prop in target || (typeof prop == "string" && target.hasAttr(prop))
      },
      ownKeys(target) {
        try {
          return [...target.keys()].map(x => String(x))
        } catch(e) {
          if (e instanceof TypeError)
                        return []
          throw e
        }
      }
    })
  }
  getType(): TypeKey {
    return rValueTypes[libexpr.nix_get_type(this)] as TypeKey
  }
  isType<T extends TypeKey[], G extends TupleToUnion<T>>(type: T): this is Value<G>
  isType<G extends TypeKey>(type: G): this is Value<G>
  isType(type: TypeKey[] | TypeKey): boolean {
    const t = this.getType()
    if (Array.isArray(type)) {
      return type.indexOf(t) !== -1
    } else {
      return t === type
    }
  }
  [customInspectSymbol](depth: number, options: util.InspectOptionsStylized, inspect: typeof util.inspect) {
    if (depth < 0) 
            return options.stylize(`<Nix ${this.getType()}>`, 'special')
    const newOptions = Object.assign({}, options, {
      depth: options.depth === undefined ? undefined : options.depth === null ? null : options.depth - 1,
    });
    const padding = ' '.repeat(5)
    const inner = inspect(this.get(), newOptions)
      .replace(/\n/g, `\n${padding}`)
    return `<${options.stylize(`Nix`, 'special')} ${inner}>`
  }
  [Symbol.toPrimitive](_hint: "number" | "string" | "default") {
    return this.get()
  }
  lookup(key: string | number) {
    const t = this.getType()
    if (t == "list") {
      const keyI = +key
      if ((keyI | 0) !== keyI) {
        throw new Error("list index must be integer")
      }
      if (keyI >= this.length) {
        throw new RangeError("list index out of range")
      }
      return new Value(this.state, libexpr.nix_get_list_byidx(this, this.state, keyI))
    } else if (t == "attrs") {
      if (libexpr.nix_has_attr_byname(this, this.state, key)) {
        return new Value(this.state, libexpr.nix_get_attr_byname(this, this.state, key))
      }
    } else {
      throw new Error("unknown property")
    }
  }
  get length() {
    const t = this.getType()
    if (t == "list") {
      return libexpr.nix_get_list_size(this)
    } else {
      throw new Error("unknown property")
    }
  }
  keys() {
    const t = this.getType()
    if (t == "list") {
      return Array(this.length).keys()
    } else if (t == "attrs") {
      const thiz = this
      return function* generator() {
        const size = libexpr.nix_get_attrs_size(thiz)
        const name = ref.alloc(ref.refType(ref.refType('string')))
        for (let i = 0; i < size; i++) {
          const val_ref = libexpr.nix_get_attr_byidx(thiz, thiz.state, i, name)
          libexpr.nix_gc_decref(val_ref)
          yield name.deref().readCString()
        }
      }()
    } else {
      throw new Error("can't get keys for " + t)
    }
  }
  hasAttr(key: number | string) {
    const t = this.getType()
    if (t == "list") {
      return (+key | 0) == +key && key < this.length
    } else if (t == "attrs") {
      return libexpr.nix_has_attr_byname(this, this.state, key)
    }
    return false
  }
  get<T extends (V extends TypeKey ? V : never)>(): TypeRegistry[T] extends never ? Converted : TypeRegistry[T]
  get<T extends (V extends TypeKey ? V : never), D extends boolean>(deep: D): TypeRegistry_<D>[T] extends never ? DeepConverted : TypeRegistry_<D>[T]
  //get(deep?: false): V extends TypeKey ? TypeRegistry[V] extends Converted ? TypeRegistry[V] : never : Converted
  //get(deep: true): V extends TypeKey ? TypeRegistryDeep[V] extends DeepConverted ? TypeRegistryDeep[V] : never : DeepConverted
  get(deep=false): Converted | DeepConverted {
    switch(this.getType()) {
        case "int": {
          const n = libexpr.nix_get_int(this)
          if (typeof n == 'string') return BigInt(n)
          return n
        }
        case "float":
          return libexpr.nix_get_float(this)
        case "bool":
          return libexpr.nix_get_bool(this)
        case "string":
          return libexpr.nix_get_string(this)
        case "path":
          return libexpr.nix_get_path_string(this)
        case "null":
          return null
        case "attrs": {
          const res: Record<string, Value<any>> | Record<string, DeepConverted> = {}
          const size = libexpr.nix_get_attrs_size(this);
          const name = ref.alloc(ref.refType(ref.refType('string')))
          for (let i = 0; i < size; i++) {
            const val_ref = libexpr.nix_get_attr_byidx(this, this.state, i, name)
            const val = new Value(this.state, val_ref)
            const attrName = name.deref().readCString()
            val.force()
            res[attrName] = deep ? val.get(true) : val
          }
          return res
        }
        case "list": {
          const size = libexpr.nix_get_list_size(this)
          const res = Array(size)
          for (let i = 0; i < size; i++)
                res[i] = new Value(this.state, libexpr.nix_get_list_byidx(this, this.state, i))
          return deep ? res.map(x => x.get(true)) : res
        }
        // case "external":
        //   return new External(this)
        case "function":
          return (x: Convertible, ...args: Convertible[]) => {
            return (this as Value<"attrs" | "function">).call(x, ...args)
          }
        default:
          throw new Error("unknown type: " + this.getType())
    }
  }
  set<T extends V>(js_obj: Value<T>): asserts this is Value<T>
  set<T extends V>(js_obj: T): asserts this is Value<T>
  set(js_obj: Convertible): void {
    if (js_obj instanceof Value) {
      libexpr.nix_copy_value(this, js_obj)
      return
    }
    switch (typeof js_obj) {
        case "number": {
          if (Number.isInteger(js_obj)) {
            libexpr.nix_set_int(this, js_obj)
          } else {
            libexpr.nix_set_float(this, js_obj)
          }
          break
        }
        case "bigint":
          libexpr.nix_set_int(this, js_obj.toString())
          break
        case "boolean":
          libexpr.nix_set_bool(this, js_obj)
          break
        case "string":
          libexpr.nix_set_string(this, js_obj)
          break
        case "object":
          if (js_obj === null) {
            libexpr.nix_set_null(this)
          } else if (Array.isArray(js_obj)) {
            const size = js_obj.length
            libexpr.nix_make_list(this.state, this, size)
            for (let i = 0; i < size; i++) {
              const val_obj: Value<unknown> = this.state.allocValue()
              libexpr.nix_set_list_byidx(this, i, val_obj)
              val_obj.set(js_obj[i])
            }
          } else {
            const keys = Object.keys(js_obj)
            const bb = new BindingsBuilder(this.state, keys.length)
            for (const key of keys) {
              const v: Value<unknown> = this.state.allocValue()
              v.set(js_obj[key])
              bb.insert(key, v)
            }
            libexpr.nix_make_attrs(this, bb)
          }
          break
        default:
          throw new Error("unknown type: " + typeof js_obj)
    }
  }
  force() {
    libexpr.nix_value_force(this.state, this)
  }
  forceDeep() {
    libexpr.nix_value_force_deep(this.state, this)
  }
  call<T extends "function" | "attrs">(this: Value<T>, arg: Convertible, ...args: Convertible[]): Value<unknown> {
    const nixArg = arg instanceof Value ? arg : this.state.makeValue(arg)
    const r = this.state.allocValue()
    libexpr.nix_value_call(this.state, this, nixArg, r)
    r.force()
    if (args.length) {
      return (r as Value<any>).call(args[0], ...args.slice(1))
    }
    return r
  }
}

const store = new Store("")
const state = new State(store)
function nix(str: string) {
  return state.eval(str)
}
const v: Value<unknown> = state.allocValue()

if (v.isType(["int", "bool"])) {
  const y = v.get()
}

//const y = n.get<"int">()
  //y

//console.log(eval_("builtins.nixVersion"))
const r = Object.assign(repl.start({useGlobal: true,
  writer: (obj: any) => util.inspect(obj, { colors: true }),
}).context, {nix, state, store, Value, Store, StorePath})
r.repl.writer.options.showProxy = false
//r.repl.setupHistory("nix-repl")

import ref from "ref-napi"
import ffi from "ffi-napi"
import repl from 'repl'
import util from 'util'

import {
    contextPtr, nix_err, nix_errs,
    libutil_fns, libutil_unwrapped,
    libstore_fns, libstore_unwrapped,
    rValueTypes, libexpr_fns, libexpr_unwrapped
} from "./lowlevel.js"



const pointer = Symbol("pointer")

ref.writePointer = function writePointer(buf, offset, ptr) {
    if (ptr && pointer in ptr) {
        ptr = ptr[pointer]
    }
    ref._writePointer(buf, offset, ptr, true)
}

function CWrapper(free_fn) {
    const freer = new FinalizationRegistry(free_fn)
    return class Wrapper {
        constructor(ref) {
            this[pointer] = ref
            freer.register(this, ref)
        }
    }
}

const getContext = function() {
    const stack = []
    let i = 0
    return function getContext(fn) {
        if (i >= stack.length) {
            stack.push(new Context())
        }
        const res = fn(stack[i++])
        i--
        return res
    }
}()

function wrapLib(fns, lib) {
    const wrapped = {
        unwrapped: lib
    }
    for (const [k, [rt, args]] of Object.entries(fns)) {
        if (args[0] == contextPtr)
            wrapped[k] = (...args) => getContext(ctx => ctx.run(lib[k], ...args))
        else
            wrapped[k] = lib[k]
    }
    return wrapped
}


class Context extends CWrapper(libutil_unwrapped.nix_c_context_free) {
    constructor() {
        super(libutil_unwrapped.nix_c_context_create())
    }
    run(fn, ...args) {
        const r = fn(this, ...args)
        if (libutil_unwrapped.nix_err_code(this) != nix_errs.NIX_OK) {
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
    constructor(store, path) {
        this.store = store
        super(libstore.nix_store_parse_path(store.ref, path))
    }
    isValid() {
        return libstore.nix_store_is_valid_path(this.store, this)
    }
    build() {
        const r = {}
        const cb = ffi.Callback('void', ['void*', 'string', 'string'], function(userdata, outname, out) {
            r[outname] = out
        })
        libstore.nix_store_build(this.store, this, null, cb)
        return r
    }
}

class Store extends CWrapper(libstore.nix_store_unref) {
    constructor(url) {
        // todo args
        super(libstore.nix_store_open(url, null))
    }
    getURI() {
        const r = Buffer.alloc(128)
        libstore.nix_store_get_uri(this, r, 128)
        return r.readCString()
    }
    parsePath(path) {
        return new StorePath(this, path)
    }
    getVersion() {
        const r = Buffer.alloc(64)
        libstore.nix_store_get_version(this, r, 128)
        return r.readCString()
    }
}

const libexpr = wrapLib(libexpr_fns, libexpr_unwrapped)
libexpr.nix_libexpr_init()

class State extends CWrapper(libexpr.nix_state_free) {
    constructor(store) {
        // todo searchPath
        super(libexpr.nix_state_create(null, store))
        this.store = store
    }
    allocValue() {
        const r = libexpr.nix_alloc_value(this)
        return new Value(this, r, false)
    }
    eval(expr, path="") {
        const r = this.allocValue()
        libexpr.nix_expr_eval_from_string(this, expr, path, r)
        r.force()
        return r
    }
}

const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

class Value extends CWrapper(libexpr.nix_gc_decref) {
    constructor(state, ref, force=true) {
        super(ref)
        this.state = state
        if (force) this.force()
        return new Proxy(this, {
            get: function(target, prop, receiver) {
                if (prop in target) {
                    return Reflect.get(...arguments)
                } else {
                    //console.log("getting", prop)
                    return target.lookup(prop)
                }
            },
            getOwnPropertyDescriptor(target, prop) {
                //console.log("getOwnPropDesc", prop)
                const op = Reflect.getOwnPropertyDescriptor(...arguments)
                if (op) return op
                if (target.hasAttr(prop)) {
                    return {
                        configurable: true,
                        enumerable: true,
                        get: () => target.lookup(prop)
                    }
                }
            },
            has(target, prop) {
                return prop in target || target.hasAttr(prop)
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
    getType() {
        return rValueTypes[libexpr.nix_get_type(this)]
    }
    [customInspectSymbol](depth, options, inspect) {
        if (depth < 0) 
            return options.stylize(`<Nix ${this.getType()}>`, 'special')
        const newOptions = Object.assign({}, options, {
            depth: options.depth === null ? null : options.depth - 1,
        });
        const padding = ' '.repeat(5)
        const inner = inspect(this.get(), newOptions)
              .replace(/\n/g, `\n${padding}`)
        return `<${options.stylize(`Nix`, 'special')} ${inner}>`
    }
    [Symbol.toPrimitive](hint) {
        return this.get()
    }
    lookup(key) {
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
                const name = ref.alloc(ref.refType('string'))
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
    hasAttr(key) {
        const t = this.getType()
        if (t == "list") {
            return (+key | 0) == +key && key < this.length
        } else if (t == "attrs") {
            return libexpr.nix_has_attr_byname(this, this.state, key)
        }
        return false
    }
    get(deep=false) {
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
            const res = {}
            const size = libexpr.nix_get_attrs_size(this);
            const name = ref.alloc(ref.refType('string'))
            for (let i = 0; i < size; i++) {
                const val_ref = libexpr.nix_get_attr_byidx(this, this.state, i, name)
                const val = new Value(this.state, val_ref)
                const attrName = name.deref().readCString()
                val.force()
                if (attrName == "") console.log(attrName, i, name.deref().readCString())
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
        case "external":
            return new External(this)
        case "function":
            return (x, ...args) => {
                const res = this.state.allocValue()
                libexpr.nix_value_call(this.state, this, x, res)
                res.force()
                if (args.length) {
                    return res.get()(...args)
                } else return res
            }
        default:
            throw new Error("unknown type: " + this.getType())
        }
    }
    force() {
        libexpr.nix_value_force(this.state, this)
    }
    forceDeep() {
        libexpr.nix_value_force_deep(this.state, this)
    }
    call(args) {
        const r = this.state.allocValue()
        libexpr.nix_value_call(this.state, this, args, r)
        r.force()
        return r
    }
}

const store = new Store("")
const state = new State(store)
function nix(str) {
    return state.eval(str)
}

//console.log(eval_("builtins.nixVersion"))
const r = Object.assign(repl.start({useGlobal: true,
                          writer: obj => util.inspect(obj, { colors: true }),
                                   }).context, {nix, state, store, Value, Store, StorePath})
r.repl.writer.options.showProxy = false
//r.repl.setupHistory("nix-repl")

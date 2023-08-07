import * as ref from "ref-napi"
import { Library } from "ffi-napi"
import type { LibraryObjectDefinitionBase  } from "ffi-napi"

const context = 'void'
export const contextPtr = ref.refType(context)
export const nix_err = 'int'

export const nix_errs = {
    NIX_OK: 0,
    NIX_ERR_UNKNOWN: -1,
    NIX_ERR_OVERFLOW: -2,
    NIX_ERR_KEY: -3,
    NIX_ERR_NIX_ERROR: -4
}

export const libutil_fns: LibraryObjectDefinitionBase = {
    'nix_version_get': [ 'string', [] ],
    'nix_libutil_init': [ nix_err, [contextPtr] ],
    'nix_c_context_create': [ contextPtr, [] ],
    'nix_c_context_free': [ 'void', [contextPtr] ],
    'nix_err_code': [ nix_err, [contextPtr] ],
    'nix_err_msg': [ 'string', [ contextPtr, contextPtr, 'int*' ] ]
}
export const libutil_unwrapped = Library('libnixutil', libutil_fns)


export const storePtr = ref.refType('void')
export const storePathPtr = ref.refType('void')

export const libstore_fns: LibraryObjectDefinitionBase = {
    nix_libstore_init: [ nix_err, [contextPtr] ],
    nix_store_open: [ storePtr, [ contextPtr, 'string', 'void***' ] ],
    nix_store_unref: [ 'void', [storePtr]],
    nix_store_get_uri: [ nix_err, [contextPtr, storePtr, 'void*', 'uint'] ],
    nix_store_parse_path: [ storePathPtr, [contextPtr, storePtr, 'string' ] ],
    nix_store_path_free: [ 'void', [storePathPtr ] ],
    nix_store_is_valid_path: [ 'bool', [contextPtr, storePtr, storePathPtr ] ],
    nix_store_build: [ nix_err, [ contextPtr, storePtr, storePathPtr, 'void*', 'pointer'] ],
    nix_store_get_version: [ nix_err, [ contextPtr, storePtr, 'void*', 'uint' ] ]
}
export const libstore_unwrapped = Library('libnixstore', libstore_fns)

export const statePtr = ref.refType('void')
export const valuePtr = ref.refType('void')
export const externalValuePtr = ref.refType('void')
export const primOpPtr = ref.refType('void')
export const bindingsBuilderPtr = ref.refType('void')
export const valueType = 'int'
export const valueTypes = {
    NIX_TYPE_THUNK: 0,
    NIX_TYPE_INT: 1,
    NIX_TYPE_FLOAT: 2,
    NIX_TYPE_BOOL: 3,
    NIX_TYPE_STRING: 4,
    NIX_TYPE_PATH: 5,
    NIX_TYPE_NULL: 6,
    NIX_TYPE_ATTRS: 7,
    NIX_TYPE_LIST: 8,
    NIX_TYPE_FUNCTION: 9,
    NIX_TYPE_EXTERNAL: 10
}
export const rValueTypes = ["thunk", "int", "float", "bool", "string", "path", "null", "attrs", "list", "function", "external"]
export const libexpr_fns: LibraryObjectDefinitionBase = {
    nix_libexpr_init: [ nix_err, [contextPtr] ],
    nix_state_create: [ statePtr, [contextPtr, ref.refType('string'), storePtr ] ],
    nix_state_free: [ 'void', [statePtr] ],
    nix_alloc_value: [ valuePtr, [ contextPtr, statePtr ] ],
    nix_expr_eval_from_string: [ nix_err, [ contextPtr, statePtr, 'string', 'string', valuePtr ] ],
    nix_value_call: [ nix_err, [ contextPtr, statePtr, valuePtr, valuePtr, valuePtr ] ],
    nix_value_force: [ nix_err, [ contextPtr, statePtr, valuePtr ] ],
    nix_value_force_deep: [ nix_err, [ contextPtr, statePtr, valuePtr ] ],
    nix_gc_incref: [ nix_err, [ contextPtr, 'void*' ] ],
    nix_gc_decref: [ nix_err, [ contextPtr, 'void*' ] ],
    nix_gc_now: [ 'void', [] ],
    nix_gc_register_finalizer: [ 'void', [ 'void*', 'void*', 'pointer' ] ],
    nix_get_type: [ valueType, [ contextPtr, valuePtr ] ],
    nix_get_typename: [ 'string', [ contextPtr, valuePtr ] ],
    nix_get_bool: [ 'bool', [ contextPtr, valuePtr ] ],
    nix_get_string: [ 'string', [ contextPtr, valuePtr ] ],
    nix_get_path_string: [ 'string', [ contextPtr, valuePtr ] ],
    nix_get_list_size: [ 'uint', [ contextPtr, valuePtr ] ],
    nix_get_attrs_size: [ 'uint', [ contextPtr, valuePtr ] ],
    nix_get_float: [ 'double', [ contextPtr, valuePtr ] ],
    nix_get_int: [ 'int64', [ contextPtr, valuePtr ] ],
    nix_get_external: [ externalValuePtr, [ contextPtr, valuePtr ] ],
    nix_get_list_byidx: [ valuePtr, [ contextPtr, valuePtr, valuePtr, 'uint' ] ],
    nix_get_attr_byname: [ valuePtr, [ contextPtr, valuePtr, statePtr, 'string' ] ],
    nix_has_attr_byname: [ 'bool', [ contextPtr, valuePtr, statePtr, 'string' ] ],
    nix_get_attr_byidx: [ valuePtr, [ contextPtr, valuePtr, statePtr, 'uint', ref.refType('string') ] ],
    nix_set_bool: [ nix_err, [ contextPtr, valuePtr, 'bool' ] ],
    nix_set_string: [ nix_err, [ contextPtr, valuePtr, 'string' ] ],
    nix_set_path_string: [ nix_err, [ contextPtr, valuePtr, 'string' ] ],
    nix_set_float: [ nix_err, [ contextPtr, valuePtr, 'double' ] ],
    nix_set_int: [ nix_err, [ contextPtr, valuePtr, 'int64' ] ],
    nix_set_null: [ nix_err, [ contextPtr, valuePtr ] ],
    nix_set_external: [ nix_err, [ contextPtr, valuePtr, externalValuePtr ] ],
    nix_make_list: [ nix_err, [ contextPtr, statePtr, valuePtr, 'uint' ] ],
    nix_set_list_byidx: [ nix_err, [ contextPtr, valuePtr, 'uint', valuePtr ] ],
    nix_make_attrs: [ nix_err, [ contextPtr, valuePtr, bindingsBuilderPtr ] ],
    nix_set_primop: [ nix_err, [ contextPtr, valuePtr, primOpPtr ] ],
    nix_copy_value: [ nix_err, [ contextPtr, valuePtr, valuePtr ] ],
    nix_make_bindings_builder: [ bindingsBuilderPtr, [ contextPtr, statePtr, 'uint' ] ],
    nix_bindings_builder_insert: [ nix_err, [ contextPtr, bindingsBuilderPtr, 'string', valuePtr ] ],
    nix_bindings_builder_free: [ 'void', [ bindingsBuilderPtr ] ],
}
export const libexpr_unwrapped = Library('libnixexpr', libexpr_fns)

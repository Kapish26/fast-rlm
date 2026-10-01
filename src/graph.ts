export interface GraphArtifact {
  version: 1;
  backend: "networkx";
  graph_type: "Graph" | "DiGraph" | "MultiGraph" | "MultiDiGraph";
  attributes: Record<string, unknown>;
  nodes: Array<{ id: unknown; attributes: Record<string, unknown> }>;
  edges: Array<{
    source: unknown;
    target: unknown;
    key?: unknown;
    attributes: Record<string, unknown>;
  }>;
  entity_index?: EntityIndexArtifact;
}

export interface EntityIndexArtifact {
  exact_index: Record<string, unknown[]>;
  trigram_index: Record<string, unknown[]>;
  node_labels: Record<string, string[]>;
}

export function assertGraphArtifact(value: unknown): GraphArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("graph artifact must be an object");
  }
  const artifact = value as Record<string, unknown>;
  const graphTypes = new Set([
    "Graph",
    "DiGraph",
    "MultiGraph",
    "MultiDiGraph",
  ]);
  if (
    artifact.version !== 1 || artifact.backend !== "networkx" ||
    typeof artifact.graph_type !== "string" ||
    !graphTypes.has(artifact.graph_type) ||
    typeof artifact.attributes !== "object" || artifact.attributes === null ||
    Array.isArray(artifact.attributes) || !Array.isArray(artifact.nodes) ||
    !Array.isArray(artifact.edges) ||
    (artifact.entity_index !== undefined &&
      (typeof artifact.entity_index !== "object" || artifact.entity_index === null))
  ) {
    throw new Error("invalid NetworkX graph artifact");
  }
  return artifact as unknown as GraphArtifact;
}

export function graphArtifactSummary(artifact: GraphArtifact) {
  return {
    backend: artifact.backend,
    graph_type: artifact.graph_type,
    nodes: artifact.nodes.length,
    edges: artifact.edges.length,
  };
}

export function consumeGraphQuery(count: number, limit: number): number {
  if (count >= limit) {
    throw new Error(
      `Graph query budget exceeded: ${count} call(s) made, limit is ${limit}`,
    );
  }
  return count + 1;
}

export function resolveMaxGraphHops(value: unknown): number {
  const hops = value ?? 4;
  if (typeof hops !== "number" || !Number.isInteger(hops) || hops < 1) {
    throw new Error("max_graph_hops must be a positive integer");
  }
  return hops;
}

export function resolveMinEntityConfidence(value: unknown): number {
  const confidence = value ?? 0.75;
  if (
    typeof confidence !== "number" || !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1
  ) {
    throw new Error("min_entity_confidence must be a number between 0 and 1");
  }
  return confidence;
}

export function entityPrecisionRecall(predicted: unknown[], gold: unknown[]) {
  const key = (value: unknown) => JSON.stringify(value);
  const predictedKeys = new Set(predicted.map(key));
  const goldKeys = new Set(gold.map(key));
  let overlap = 0;
  for (const value of predictedKeys) if (goldKeys.has(value)) overlap++;
  return {
    precision: predictedKeys.size === 0
      ? (goldKeys.size === 0 ? 1 : 0)
      : overlap / predictedKeys.size,
    recall: goldKeys.size === 0
      ? (predictedKeys.size === 0 ? 1 : 0)
      : overlap / goldKeys.size,
  };
}

export function seedEntityNames(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const value = candidate && typeof candidate === "object"
      ? (candidate as Record<string, unknown>).name ??
        (candidate as Record<string, unknown>).node
      : candidate;
    if (value === null || value === undefined) continue;
    const name = String(value);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export const TOON_PRINT_PY = String.raw`
import builtins as __builtins__
import itertools as __print_itertools__
import json as __print_json__

if globals().get("__graph_print_encoding__", "toon") == "toon":
    from toon_format import encode as __toon_encode__

__real_print__ = __builtins__.print
__TOON_PRINT_LIMIT__ = 20

def __is_neo4j_graph_for_print__(_graph):
    if _graph.graph.get("source_backend") == "neo4j":
        return True
    if any("neo4j_element_id" in _data for _, _data in _graph.nodes(data=True)):
        return True
    return any("neo4j_element_id" in _data for _, _, _data in _graph.edges(data=True))

def __networkx_graph_for_print__(_graph):
    if __is_neo4j_graph_for_print__(_graph):
        _neo4j_printer = globals().get("__neo4j_graph_for_print__")
        if _neo4j_printer is not None:
            return _neo4j_printer(_graph)
    _node_ids = list(__print_itertools__.islice(_graph.nodes, __TOON_PRINT_LIMIT__))
    _node_id_set = set(_node_ids)
    _nodes = [
        {"id": _node, "attributes": dict(_graph.nodes[_node])}
        for _node in _node_ids
    ]
    _edges = []
    if _graph.is_multigraph():
        _edge_iter = _graph.edges(keys=True, data=True)
        for _source, _target, _key, _attributes in _edge_iter:
            if _source in _node_id_set and _target in _node_id_set:
                _edges.append({
                    "source": _source,
                    "target": _target,
                    "key": _key,
                    "attributes": dict(_attributes),
                })
                if len(_edges) == __TOON_PRINT_LIMIT__:
                    break
    else:
        _edge_iter = _graph.edges(data=True)
        for _source, _target, _attributes in _edge_iter:
            if _source in _node_id_set and _target in _node_id_set:
                _edges.append({
                    "source": _source,
                    "target": _target,
                    "attributes": dict(_attributes),
                })
                if len(_edges) == __TOON_PRINT_LIMIT__:
                    break

    _raw_records = _graph.graph.get("records", [])
    if isinstance(_raw_records, (list, tuple)):
        _total_records = len(_raw_records)
        _records = list(_raw_records[:__TOON_PRINT_LIMIT__])
    elif _raw_records is None:
        _total_records = 0
        _records = []
    else:
        _total_records = 1
        _records = [_raw_records]

    _total_nodes = _graph.number_of_nodes()
    _total_edges = _graph.number_of_edges()
    return {
        "graph_type": type(_graph).__name__,
        "directed": _graph.is_directed(),
        "multigraph": _graph.is_multigraph(),
        "total_nodes": _total_nodes,
        "shown_nodes": len(_nodes),
        "nodes_truncated": _total_nodes > len(_nodes),
        "total_edges": _total_edges,
        "shown_edges": len(_edges),
        "edges_truncated": _total_edges > len(_edges),
        "total_records": _total_records,
        "shown_records": len(_records),
        "records_truncated": _total_records > len(_records),
        "graph_attributes": {
            _key: _value for _key, _value in _graph.graph.items()
            if _key != "records"
        },
        "nodes": _nodes,
        "edges": _edges,
        "records": _records,
    }

def __networkx_view_for_print__(_view):
    _neo4j_printer = globals().get("__neo4j_view_for_print__")
    if _neo4j_printer is not None:
        _neo4j_projection = _neo4j_printer(_view)
        if _neo4j_projection is not None:
            return _neo4j_projection
    _total = len(_view)
    _module = type(_view).__module__
    _view_type = type(_view).__name__
    if _module.startswith("networkx.classes.coreviews") and hasattr(_view, "__getitem__"):
        _keys = list(__print_itertools__.islice(iter(_view), __TOON_PRINT_LIMIT__))
        _items = [{"key": _key, "value": _view[_key]} for _key in _keys]
    else:
        _raw_items = list(__print_itertools__.islice(iter(_view), __TOON_PRINT_LIMIT__))
        if _view_type == "NodeDataView":
            _items = [
                {"node": _item[0], "attributes": dict(_item[1])}
                for _item in _raw_items
            ]
        elif "DegreeView" in _view_type:
            _items = [
                {"node": _item[0], "degree": _item[1]}
                for _item in _raw_items
            ]
        elif "Edge" in _view_type:
            _items = []
            for _item in _raw_items:
                _row = {"source": _item[0], "target": _item[1]}
                if len(_item) == 3:
                    if isinstance(_item[2], dict):
                        _row["attributes"] = dict(_item[2])
                    else:
                        _row["key"] = _item[2]
                elif len(_item) == 4:
                    _row["key"] = _item[2]
                    _row["attributes"] = dict(_item[3])
                _items.append(_row)
        else:
            _items = _raw_items
    return {
        "view_type": _view_type,
        "total_items": _total,
        "shown_items": len(_items),
        "truncated": _total > len(_items),
        "items": _items,
    }

def __coerce_for_print__(o, _seen=None):
    if isinstance(o, (str, bytes, int, float, bool)) or o is None:
        _sanitizer = globals().get("__neo4j_scalar_for_print__")
        if _sanitizer is not None:
            return _sanitizer(o)
        return o
    if _seen is None:
        _seen = set()
    _oid = id(o)
    if _oid in _seen:
        raise ValueError("cyclic structured value")
    _seen.add(_oid)
    try:
        try:
            from pydantic import BaseModel as __BaseModel
            if isinstance(o, __BaseModel):
                o = o.model_dump(mode="json")
        except ImportError:
            pass
        if hasattr(o, "to_py") and not isinstance(o, (str, bytes)):
            o = o.to_py()
        try:
            import networkx as __print_nx__
            if isinstance(o, __print_nx__.Graph):
                o = __networkx_graph_for_print__(o)
            elif type(o).__module__.startswith((
                "networkx.classes.reportviews",
                "networkx.classes.coreviews",
            )):
                o = __networkx_view_for_print__(o)
        except ImportError:
            pass
        _sanitizer = globals().get("__neo4j_structured_for_print__")
        if _sanitizer is not None:
            o = _sanitizer(o)
        if isinstance(o, dict):
            return {
                str(_key): __coerce_for_print__(_value, _seen)
                for _key, _value in o.items()
            }
        if isinstance(o, (list, tuple)):
            _values = o
            if "__neo4j_print_role__" in globals():
                _values = o[:10]
                _sanitizer = globals().get("__neo4j_collection_item_for_print__")
                if _sanitizer is not None:
                    _values = [_sanitizer(_value) for _value in _values]
            return [__coerce_for_print__(_value, _seen) for _value in _values]
        if isinstance(o, set):
            _values = sorted(o, key=repr)
            if "__neo4j_print_role__" in globals():
                _values = _values[:10]
            return [
                __coerce_for_print__(_value, _seen)
                for _value in _values
            ]
        return o
    finally:
        _seen.remove(_oid)

def print(*args, __emit=__real_print__, **kwargs):
    _out = []
    for _value in args:
        if isinstance(_value, (str, bytes, int, float, bool)) or _value is None:
            _sanitizer = globals().get("__neo4j_scalar_for_print__")
            if _sanitizer is not None:
                _value = _sanitizer(_value)
            _text = str(_value)
            _out.append(_text[:1024] + ("…" if len(_text) > 1024 else ""))
            continue
        _type_name = type(_value).__name__
        try:
            _coerced = __coerce_for_print__(_value)
            if _coerced is _value:
                _out.append(_value)
            elif globals().get("__graph_print_encoding__", "toon") == "toon":
                _out.append(__toon_encode__(_coerced, {"delimiter": ","}))
            else:
                _out.append(__print_json__.dumps(
                    _coerced, ensure_ascii=False, default=str, separators=(",", ":")
                ))
        except Exception:
            _out.append(f"[TOON encoding failed: {_type_name}]")
    __emit(*_out, **kwargs)

__builtins__.print = print
del __real_print__
`;

export const GRAPH_RUNTIME_PY = String.raw`
import networkx as __nx
import ast as __graph_ast
import json as __graph_json
import re as __graph_re
import difflib as __graph_difflib
import networkx as nx
from collections import deque as __graph_deque

__GRAPH_OPERATION_ALLOWLIST__ = {
    "out_edges", "in_edges", "neighbors", "predecessors", "successors",
    "degree", "in_degree", "out_degree", "subgraph", "edge_subgraph",
    "shortest_path", "shortest_path_length", "bfs_edges", "bfs_tree",
    "dfs_edges", "dfs_tree", "single_source_shortest_path_length",
}
__graph_runtime_operations__ = set()
__graph_runtime_seeds__ = []
__neo4j_verified_seed_keys__ = []
__graph_runtime_seed_source__ = "none"
__graph_runtime_seed_methods__ = []
__graph_runtime_entity_mentions__ = []
__graph_runtime_seed_candidates__ = []
__graph_runtime_candidate_count__ = 0
__graph_runtime_entity_precision__ = None
__graph_runtime_entity_recall__ = None
__graph_seed_resolution_called__ = False
__neo4j_seed_names_seen__ = set()

def __graph_operations__(_code):
    try:
        _tree = __graph_ast.parse(_code)
    except SyntaxError:
        return []
    return sorted({
        _node.func.attr
        for _node in __graph_ast.walk(_tree)
        if isinstance(_node, __graph_ast.Call)
        and isinstance(_node.func, __graph_ast.Attribute)
        and _node.func.attr in __GRAPH_OPERATION_ALLOWLIST__
    })

def legacy_find_graph_seeds(_graph, _question, _relation_terms=(), _max_seeds=3):
    """Resolve question phrases to verified graph nodes without external IDs."""
    global __graph_runtime_seed_methods__
    _question_text = __graph_re.sub(r"[^\w]+", " ", str(_question).casefold()).strip()
    _question_tokens = set(_question_text.split())
    if not _question_text:
        return []

    _terms = [str(_term).strip().casefold().replace(" ", "_")
              for _term in _relation_terms if str(_term).strip()]
    _generic_singletons = {
        "what", "which", "who", "where", "when", "why", "how", "did",
        "does", "was", "were", "is", "are", "before", "after", "president",
        "person", "place", "thing", "data", "name", "title", "role",
    }
    _label_fields = {"name", "label", "title", "alias", "aliases"}
    _label_relations = {
        "name", "label", "title", "alias", "type_object_name",
        "common_topic_alias",
    }
    _candidates = {}

    def _normalized(_value):
        return __graph_re.sub(r"[^\w]+", " ", str(_value).casefold()).strip()

    def _readable(_value):
        _text = str(_value)
        return 0 < len(_text) <= 200 and not _text.startswith(("m.", "g.", "/"))

    def _aliases(_value):
        if isinstance(_value, (list, tuple, set)):
            return list(_value)
        return [_value]

    def _relation_context(_node):
        _matched = set()
        if _graph.is_directed():
            __graph_runtime_operations__.update(("out_edges", "in_edges"))
            if _graph.is_multigraph():
                _edges = list(_graph.out_edges(_node, keys=True, data=True))
                _edges += list(_graph.in_edges(_node, keys=True, data=True))
                _relations = [str(_data.get("relation", _key)).casefold()
                              for _, _, _key, _data in _edges]
            else:
                _edges = list(_graph.out_edges(_node, data=True))
                _edges += list(_graph.in_edges(_node, data=True))
                _relations = [str(_data.get("relation", "")).casefold()
                              for _, _, _data in _edges]
        else:
            __graph_runtime_operations__.add("neighbors")
            if _graph.is_multigraph():
                _relations = [str(_data.get("relation", _key)).casefold()
                              for _, _, _key, _data
                              in _graph.edges(_node, keys=True, data=True)]
            else:
                _relations = [str(_data.get("relation", "")).casefold()
                              for _, _, _data in _graph.edges(_node, data=True)]
        for _relation in _relations:
            _text = _relation.replace(".", "_").replace("/", "_").replace(" ", "_")
            _matched.update(_term for _term in _terms if _term in _text)
        return min(30, 5 * len(_matched))

    def _consider(_node, _alias, _method):
        _alias_text = _normalized(_alias)
        _tokens = _alias_text.split()
        if not _tokens or (len(_tokens) == 1 and
                           (_tokens[0] in _generic_singletons or len(_tokens[0]) < 3)):
            return
        if f" {_alias_text} " in f" {_question_text} ":
            _score = 100 + 20 * len(_tokens) + min(len(_alias_text), 20)
            _match_method = "exact_normalized_" + _method
        elif len(_tokens) >= 2 and all(_token in _question_tokens for _token in _tokens):
            _score = 50 + 10 * len(_tokens)
            _match_method = "token_subset_" + _method
        else:
            return
        _score += _relation_context(_node)
        _current = _candidates.get(_node)
        if _current is None or _score > _current[0]:
            _candidates[_node] = (_score, _match_method)

    for _node, _attributes in _graph.nodes(data=True):
        if _readable(_node):
            _consider(_node, _node, "node")
        for _field in _label_fields:
            if _field in _attributes:
                for _alias in _aliases(_attributes[_field]):
                    _consider(_node, _alias, "attribute")

    if _graph.is_multigraph():
        _edges = _graph.edges(keys=True, data=True)
        _label_edges = ((_u, _v, str(_data.get("relation", _key)))
                        for _u, _v, _key, _data in _edges)
    else:
        _edges = _graph.edges(data=True)
        _label_edges = ((_u, _v, str(_data.get("relation", "")))
                        for _u, _v, _data in _edges)
    for _u, _v, _relation in _label_edges:
        _relation_name = _relation.casefold().replace(".", "_").replace("/", "_")
        if not any(_label in _relation_name for _label in _label_relations):
            continue
        if _readable(_v):
            _consider(_u, _v, "edge_label")
        if _readable(_u):
            _consider(_v, _u, "edge_label")

    _ranked = sorted(
        ((_score, str(_node), _node, _method)
         for _node, (_score, _method) in _candidates.items()),
        key=lambda _item: (-_item[0], _item[1]),
    )
    if not _ranked:
        __graph_runtime_seed_methods__ = []
        return []
    _best_score = _ranked[0][0]
    _selected = [(_node, _method) for _score, _, _node, _method in _ranked
                 if _score >= _best_score - 10][:_max_seeds]
    __graph_runtime_seed_methods__ = sorted({_method for _, _method in _selected})
    return [_node for _node, _ in _selected]

def find_graph_seeds(_graph, _entity_index, _entity_mentions, _relation_terms,
                     _max_candidates=20, _max_seeds=3, _min_confidence=0.75):
    """Resolve complete question mentions through the prepared index."""
    global __graph_runtime_seed_methods__, __graph_runtime_entity_mentions__
    global __graph_runtime_seed_candidates__, __graph_runtime_candidate_count__
    global __graph_runtime_seed_source__, __graph_runtime_seeds__
    global __graph_runtime_entity_precision__, __graph_runtime_entity_recall__
    def _normalized(_value):
        return __graph_re.sub(r"[^\w]+", " ", str(_value).casefold()).strip()
    def _trigrams(_value):
        return {_value[_i:_i + 3] for _i in range(max(0, len(_value) - 2))}
    _mentions = [_normalized(_value) for _value in (_entity_mentions or [])]
    _mentions = [_value for _value in _mentions if _value]
    __graph_runtime_entity_mentions__ = _mentions
    __graph_runtime_seed_source__ = "question"
    _terms = [str(_term).strip().casefold().replace(" ", "_")
              for _term in _relation_terms if str(_term).strip()]
    _index = _entity_index or {}
    _exact, _trigram_index = _index.get("exact_index", {}), _index.get("trigram_index", {})
    _labels = _index.get("node_labels", {})
    _retrieved = {}
    for _mention in _mentions:
        for _node in _exact.get(_mention, []):
            _retrieved.setdefault(_node, []).append((_mention, 1.0))
        _query_trigrams = _trigrams(_mention)
        _overlap = {}
        for _trigram in _query_trigrams:
            for _node in _trigram_index.get(_trigram, []):
                _overlap[_node] = _overlap.get(_node, 0) + 1
        for _node, _count in _overlap.items():
            _candidate_trigrams = set()
            for _label in _labels.get(str(_node), []):
                _candidate_trigrams.update(_trigrams(_label))
            _dice = 2.0 * _count / max(1, len(_query_trigrams) + len(_candidate_trigrams))
            _retrieved.setdefault(_node, []).append((_mention, _dice))
    if not _retrieved:
        __graph_runtime_seed_methods__ = []
        __graph_runtime_seed_candidates__ = []
        __graph_runtime_candidate_count__ = 0
        __graph_runtime_seeds__ = []
        return []

    def _token_quality(_a, _b):
        if _a == _b:
            return 1.0, "exact"
        _short, _long = sorted((_a, _b), key=len)
        if len(_short) >= 3 and _long.startswith(_short):
            return 0.9, "prefix"
        _ratio = __graph_difflib.SequenceMatcher(None, _a, _b).ratio()
        return (_ratio, "trigram") if _ratio >= 0.78 else (0.0, "")

    def _label_score(_mention, _label, _base_dice):
        _mention_tokens, _label_tokens = _mention.split(), _label.split()
        _qualities = [max((_token_quality(_token, _candidate)[0]
                           for _candidate in _label_tokens), default=0.0)
                      for _token in _mention_tokens]
        _label_qualities = [max((_token_quality(_token, _mention_token)[0]
                                 for _mention_token in _mention_tokens), default=0.0)
                            for _token in _label_tokens]
        _mention_coverage = sum(_quality >= 0.78 for _quality in _qualities) / max(1, len(_mention_tokens))
        _candidate_coverage = sum(_quality >= 0.78 for _quality in _label_qualities) / max(1, len(_label_tokens))
        _exact = sum(_quality == 1.0 for _quality in _qualities) / max(1, len(_mention_tokens))
        _prefix = sum(0.0 < _quality < 1.0 for _quality in _qualities) / max(1, len(_mention_tokens))
        _score = (0.30 * _base_dice + 0.25 * _mention_coverage +
                  0.15 * _candidate_coverage + 0.15 * _exact + 0.15 * _prefix)
        if len(_mention_tokens) > 1 and len(_label_tokens) == 1 and _label != _mention:
            _score *= 0.55
        _method = "trigram_prefix" if _prefix else "partial_trigram"
        return _score, _mention_coverage, _method

    _scored = []
    for _node, _matches in _retrieved.items():
        if _node not in _graph:
            continue
        for _mention, _dice in _matches:
            for _label in _labels.get(str(_node), []):
                _score, _coverage, _method = _label_score(_mention, _label, _dice)
                if _label == _mention:
                    _score, _method = max(_score, 0.95), "exact_label"
                _scored.append((_score, _node, _mention, _coverage, _method))
    _scored.sort(key=lambda _item: (-_item[0], str(_item[1]), _item[2]))
    _scored = _scored[:_max_candidates]

    def _relation_score(_node):
        _matched = set()
        if _graph.is_directed():
            __graph_runtime_operations__.update(("out_edges", "in_edges"))
            if _graph.is_multigraph():
                _edges = list(_graph.out_edges(_node, keys=True, data=True)) + list(_graph.in_edges(_node, keys=True, data=True))
                _relations = [str(_data.get("relation", _key)).casefold() for _, _, _key, _data in _edges]
            else:
                _edges = list(_graph.out_edges(_node, data=True)) + list(_graph.in_edges(_node, data=True))
                _relations = [str(_data.get("relation", "")).casefold() for _, _, _data in _edges]
        else:
            __graph_runtime_operations__.add("neighbors")
            _relations = [str(_data.get("relation", "")).casefold() for _, _, _data in _graph.edges(_node, data=True)]
        for _relation in _relations:
            _relation = _relation.replace(".", "_").replace("/", "_").replace(" ", "_")
            _matched.update(_term for _term in _terms if _term in _relation)
        return min(0.20, 0.20 * len(_matched) / max(1, len(_terms)))

    _reranked = [(min(1.0, _score + _relation_score(_node)), _node, _mention, _coverage, _method)
                 for _score, _node, _mention, _coverage, _method in _scored]
    _reranked.sort(key=lambda _item: (-_item[0], str(_item[1]), _item[2]))
    __graph_runtime_candidate_count__ = len(_reranked)
    _selected, _seen = [], set()
    for _score, _node, _mention, _coverage, _method in _reranked:
        _score = min(1.0, _score)
        if _score < _min_confidence or _node in _seen:
            continue
        _seen.add(_node)
        _selected.append(_node)
        if len(_selected) == _max_seeds:
            break
    __graph_runtime_seed_candidates__ = [
        {"node": _node, "score": round(_score, 4), "method": _method,
         "mention_coverage": round(_coverage, 4)}
        for _score, _node, _mention, _coverage, _method in _reranked[:5]
    ]
    __graph_runtime_seed_methods__ = sorted({_item[4] for _item in _reranked[:5]})
    __graph_runtime_seeds__ = list(_selected)
    return _selected

def bounded_graph_subgraph(
    _graph, _seeds, _relation_terms, _max_hops, _max_edges=20, _question=None
):
    """Return complete, relation-guided paths from seeds within a fixed cutoff."""
    global __graph_runtime_seeds__, __graph_runtime_seed_source__
    global __graph_runtime_seed_methods__
    global __graph_seed_resolution_called__
    global __graph_runtime_entity_precision__, __graph_runtime_entity_recall__
    __graph_seed_resolution_called__ = True
    _supplied_seeds = _seeds
    if isinstance(_seeds, str):
        _seeds = [_seeds]
    if not _seeds:
        _seeds = []
    _previous_runtime_seeds = list(__graph_runtime_seeds__)
    if _seeds is None:
        _seeds = []
    _seeds = [_seed for _seed in _seeds if _seed in _graph]
    __graph_runtime_seeds__ = list(_seeds)
    __graph_runtime_entity_precision__ = None
    __graph_runtime_entity_recall__ = None
    if isinstance(context, dict) and "q_entity" in context:
        _gold = context.get("q_entity") or []
        if isinstance(_gold, str):
            _gold = [_gold]
        _gold = set(_gold)
        _predicted = set(_seeds)
        __graph_runtime_entity_precision__ = (
            1.0 if not _predicted and not _gold
            else len(_predicted & _gold) / len(_predicted) if _predicted else 0.0
        )
        __graph_runtime_entity_recall__ = (
            1.0 if not _predicted and not _gold
            else len(_predicted & _gold) / len(_gold) if _gold else 0.0
        )
    if (_supplied_seeds and __graph_runtime_seed_source__ == "question"
            and list(_seeds) != _previous_runtime_seeds):
        __graph_runtime_seed_source__ = "context"
    elif _supplied_seeds and __graph_runtime_seed_source__ != "question":
        __graph_runtime_seed_source__ = "context"
    elif not _seeds:
        __graph_runtime_seed_source__ = "none"
    if __graph_runtime_seed_source__ == "context":
        __graph_runtime_seed_methods__ = ["supplied"]
    elif __graph_runtime_seed_source__ == "none":
        __graph_runtime_seed_methods__ = []
    _terms = [str(_term).strip().lower().replace(" ", "_")
              for _term in _relation_terms if str(_term).strip()]
    if not _seeds or not _terms:
        return _graph.__class__()

    _descriptor_weights = {
        "office_position_or_title": 40,
        "basic_title": 20,
        "name": 12,
        "label": 12,
        "title": 12,
        "value": 10,
        "role": 10,
    }

    def _relation(_key, _data):
        return str(_data.get("relation", _key)).lower()

    def _normalized(_relation_name):
        return _relation_name.replace(".", "_").replace("/", "_").replace(" ", "_")

    def _term_score(_relation_name):
        _text = _normalized(_relation_name)
        return 10 * sum(_term in _text for _term in _terms)

    def _descriptor_score(_relation_name):
        _text = _normalized(_relation_name)
        return max((_weight for _term, _weight in _descriptor_weights.items()
                    if _term in _text), default=0)

    def _human_readable(_node):
        _text = str(_node)
        return (
            _node not in _seeds and 0 < len(_text) <= 200
            and not _text.startswith(("m.", "g.", "/"))
        )

    def _incident(_node):
        if _graph.is_directed():
            __graph_runtime_operations__.update(("out_edges", "in_edges"))
            if _graph.is_multigraph():
                _out = list(_graph.out_edges(_node, keys=True, data=True))
                _in = list(_graph.in_edges(_node, keys=True, data=True))
                return [(_u, _v, _key, _data, (_u, _v, _key), _v)
                        for _u, _v, _key, _data in _out] + [
                    (_u, _v, _key, _data, (_u, _v, _key), _u)
                    for _u, _v, _key, _data in _in
                ]
            _out = list(_graph.out_edges(_node, data=True))
            _in = list(_graph.in_edges(_node, data=True))
            return [(_u, _v, None, _data, (_u, _v), _v)
                    for _u, _v, _data in _out] + [
                (_u, _v, None, _data, (_u, _v), _u)
                for _u, _v, _data in _in
            ]
        __graph_runtime_operations__.add("neighbors")
        if _graph.is_multigraph():
            return [(_u, _v, _key, _data, (_u, _v, _key),
                     _v if _u == _node else _u)
                    for _u, _v, _key, _data
                    in _graph.edges(_node, keys=True, data=True)]
        return [(_u, _v, None, _data, (_u, _v), _v if _u == _node else _u)
                for _u, _v, _data in _graph.edges(_node, data=True)]

    _queue = __graph_deque(
        (_seed, 0, [], {_seed}) for _seed in _seeds
    )
    _best_depth = {_seed: 0 for _seed in _seeds}
    _candidates = []
    while _queue:
        _node, _depth, _path, _path_nodes = _queue.popleft()
        if _depth >= _max_hops:
            continue
        for _u, _v, _key, _data, _edge_id, _neighbor in _incident(_node):
            if _neighbor in _path_nodes:
                continue
            _relation_name = _relation(_key, _data)
            _term = _term_score(_relation_name)
            _descriptor = _descriptor_score(_relation_name)
            if _depth == 0 and _term == 0:
                continue
            if _depth > 0 and _term == 0 and _descriptor == 0:
                continue
            _next_path = _path + [(_edge_id, _u, _v, _relation_name)]
            _next_depth = _depth + 1
            _is_human_readable = _human_readable(_neighbor)
            if _is_human_readable:
                _score = sum(
                    _term_score(_rel) + _descriptor_score(_rel)
                    for _, _, _, _rel in _next_path
                ) - _next_depth
                _, _first_u, _first_v, _first_relation = _next_path[0]
                if _first_u in _seeds:
                    _score += 30
                elif (_first_v in _seeds
                      and "office_holder" in _normalized(_first_relation)):
                    _score += 30
                _candidates.append((_score, str(_neighbor), _next_path))
            if (not _is_human_readable and _next_depth < _max_hops
                    and _next_depth < _best_depth.get(_neighbor, _max_hops + 1)):
                _best_depth[_neighbor] = _next_depth
                _queue.append((_neighbor, _next_depth, _next_path, _path_nodes | {_neighbor}))

    _selected = []
    _selected_set = set()
    _terminals = set()
    _selected_paths = []
    _path_edge_budget = max(1, (_max_edges * 3) // 4)
    for _, _terminal, _path in sorted(_candidates, key=lambda _item: (-_item[0], len(_item[2]), _item[1])):
        if _terminal in _terminals:
            continue
        _new_edges = [_edge_id for _edge_id, _, _, _ in _path
                      if _edge_id not in _selected_set]
        if len(_selected) + len(_new_edges) > _path_edge_budget:
            continue
        _terminals.add(_terminal)
        _selected_paths.append(_path)
        for _edge_id in _new_edges:
            _selected.append(_edge_id)
            _selected_set.add(_edge_id)

    if _graph.is_directed():
        for _path in _selected_paths:
            for _, _u, _v, _ in _path:
                if len(_selected) >= _max_edges:
                    break
                _reverse = _graph.get_edge_data(_v, _u, default={})
                if _graph.is_multigraph():
                    _reverse_items = _reverse.items()
                else:
                    _reverse_items = [(None, _reverse)] if _reverse else []
                for _key, _data in _reverse_items:
                    _edge_id = (_v, _u, _key) if _graph.is_multigraph() else (_v, _u)
                    if (_edge_id not in _selected_set
                            and _term_score(_relation(_key, _data)) > 0):
                        _selected.append(_edge_id)
                        _selected_set.add(_edge_id)
                        break

    if not _selected:
        return _graph.__class__()
    __graph_runtime_operations__.add("edge_subgraph")
    return _graph.edge_subgraph(_selected[:_max_edges]).copy()

def __artifact_to_graph__(artifact):
    if hasattr(artifact, "to_py"):
        artifact = artifact.to_py()
    _classes = {
        "Graph": __nx.Graph,
        "DiGraph": __nx.DiGraph,
        "MultiGraph": __nx.MultiGraph,
        "MultiDiGraph": __nx.MultiDiGraph,
    }
    _kind = artifact.get("graph_type")
    if artifact.get("version") != 1 or artifact.get("backend") != "networkx" or _kind not in _classes:
        raise TypeError("invalid NetworkX graph artifact")
    _graph = _classes[_kind]()
    _graph.graph.update(artifact.get("attributes", {}))
    for _node in artifact.get("nodes", []):
        _graph.add_node(_node["id"], **_node.get("attributes", {}))
    for _edge in artifact.get("edges", []):
        if _graph.is_multigraph():
            _graph.add_edge(
                _edge["source"], _edge["target"], key=_edge.get("key"),
                **_edge.get("attributes", {})
            )
        else:
            _graph.add_edge(
                _edge["source"], _edge["target"], **_edge.get("attributes", {})
            )
    _neo4j_register = globals().get("__neo4j_register_graph__")
    if _neo4j_register is not None:
        _neo4j_register(_graph)
    return _graph

def __graph_to_artifact__(_graph, _entity_index=None):
    _graph_types = {
        __nx.Graph: "Graph",
        __nx.DiGraph: "DiGraph",
        __nx.MultiGraph: "MultiGraph",
        __nx.MultiDiGraph: "MultiDiGraph",
    }
    if type(_graph) not in _graph_types:
        raise TypeError(
            "graph_query and GRAPH_FINAL require a networkx Graph, DiGraph, "
            "MultiGraph, or MultiDiGraph"
        )
    _nodes = [
        {"id": _node, "attributes": dict(_attributes)}
        for _node, _attributes in _graph.nodes(data=True)
    ]
    if _graph.is_multigraph():
        _edges = [
            {
                "source": _source,
                "target": _target,
                "key": _key,
                "attributes": dict(_attributes),
            }
            for _source, _target, _key, _attributes
            in _graph.edges(keys=True, data=True)
        ]
    else:
        _edges = [
            {
                "source": _source,
                "target": _target,
                "attributes": dict(_attributes),
            }
            for _source, _target, _attributes in _graph.edges(data=True)
        ]
    _artifact = {
        "version": 1,
        "backend": "networkx",
        "graph_type": _graph_types[type(_graph)],
        "attributes": dict(_graph.graph),
        "nodes": _nodes,
        "edges": _edges,
    }
    if _entity_index is not None:
        _artifact["entity_index"] = _entity_index
    import json as _graph_json
    try:
        _encoded = _graph_json.dumps(_artifact, allow_nan=False)
        if _graph_json.loads(_encoded) != _artifact:
            raise TypeError
    except (TypeError, ValueError) as _error:
        raise TypeError(
            "graph nodes, edge keys, and attributes must be JSON-compatible"
        ) from _error
    return _artifact
`;

export function graphFinalSetup(
  graphAgent: boolean,
  maxGraphHops = 4,
  neo4jMode = false,
): string {
  if (graphAgent) {
    if (neo4jMode) {
      return String.raw`__graph_final_result__ = None
__graph_final_result_set__ = False
__graph_final_error__ = None

def __reject_graph_final__(_category):
    global __graph_final_error__, __graph_final_result__, __graph_final_result_set__
    __graph_final_error__ = _category
    __graph_final_result__ = None
    __graph_final_result_set__ = False
    raise ValueError(f"final_graph_rejected: {_category}")

def FINAL(_value):
    raise RuntimeError("Graph children must finish with GRAPH_FINAL(graph), not FINAL(...)")

def GRAPH_FINAL(value):
    global __graph_final_result__, __graph_final_result_set__, __graph_final_error__
    __graph_final_error__ = None
    if type(value) is not __nx.MultiDiGraph:
        __reject_graph_final__("wrong_type")
    if value.number_of_edges() > 20 or value.number_of_nodes() > 40:
        __reject_graph_final__("size_limit")
    _facts = value.graph.get("facts", [])
    _records = value.graph.get("records")
    if (_records and
            _records is not evidence_graph.graph.get("records")):
        __reject_graph_final__("records")
    if not isinstance(_facts, list) or len(_facts) > 10:
        __reject_graph_final__("facts")
    _evidence_facts = set()
    for _record in evidence_graph.graph.get("records", []):
        if not isinstance(_record, dict):
            continue
        for _name, _fact_value in _record.items():
            if (not isinstance(_name, str) or
                    isinstance(_fact_value, (dict, list, tuple, set))):
                continue
            try:
                _evidence_facts.add(__graph_json.dumps(
                    {"name": _name, "value": _fact_value},
                    ensure_ascii=False, allow_nan=False, sort_keys=True,
                ))
            except (TypeError, ValueError):
                continue
    for _fact in _facts:
        if (not isinstance(_fact, dict) or set(_fact) != {"name", "value"} or
                not isinstance(_fact["name"], str) or
                isinstance(_fact["value"], (dict, list, tuple, set))):
            __reject_graph_final__("facts")
        try:
            _fact_json = __graph_json.dumps(
                _fact, ensure_ascii=False, allow_nan=False, sort_keys=True,
            )
        except (TypeError, ValueError):
            __reject_graph_final__("facts")
        if (len(_fact_json.encode("utf-8")) > 512 or
                _fact_json not in _evidence_facts):
            __reject_graph_final__("facts")
    for _node_id in value.nodes:
        if _node_id not in evidence_graph:
            __reject_graph_final__("unknown_node")
    _resolved_edges = []
    _seen_edges = set()
    for _source, _target, _key, _data in value.edges(keys=True, data=True):
        _evidence_key = _key
        if not evidence_graph.has_edge(_source, _target, _evidence_key):
            _relationship_id = _data.get("neo4j_element_id")
            if (not isinstance(_relationship_id, str) or
                    not evidence_graph.has_edge(
                        _source, _target, _relationship_id
                    )):
                __reject_graph_final__("unknown_edge")
            _evidence_key = _relationship_id
        _edge_id = (_source, _target, _evidence_key)
        if _edge_id in _seen_edges:
            __reject_graph_final__("duplicate_edge")
        _seen_edges.add(_edge_id)
        _resolved_edges.append(_edge_id)
    _canonical = __nx.MultiDiGraph()
    _canonical.graph.update({"source_backend": "neo4j", "facts": [dict(_fact) for _fact in _facts]})
    for _node_id in value.nodes:
        _canonical.add_node(_node_id, **dict(evidence_graph.nodes[_node_id]))
    for _source, _target, _key in _resolved_edges:
        _canonical.add_edge(
            _source, _target, key=_key,
            **dict(evidence_graph.edges[_source, _target, _key])
        )
    try:
        __graph_final_result__ = __graph_to_artifact__(_canonical)
    except (TypeError, ValueError):
        __reject_graph_final__("serialization")
    __graph_final_result_set__ = True
    __graph_final_error__ = None
`;
    }
    return String.raw`__graph_final_result__ = None
__graph_final_result_set__ = False

def FINAL(_value):
    raise RuntimeError("Graph children must finish with GRAPH_FINAL(graph), not FINAL(...)")

def GRAPH_FINAL(value):
    global __graph_final_result__, __graph_final_result_set__
    if value.number_of_edges() > 20:
        raise ValueError("GRAPH_FINAL accepts at most 20 edges")
    if value.number_of_nodes() > 0:
        _seeds = list(__graph_runtime_seeds__)
        if not _seeds and isinstance(context, dict):
            _seeds = context.get("q_entity", [])
        if isinstance(_seeds, str):
            _seeds = [_seeds]
        _present_seeds = [_seed for _seed in _seeds if _seed in value]
        if value.number_of_edges() > 0 and not _present_seeds:
            raise ValueError("GRAPH_FINAL must preserve a complete path from a verified seed")
        _reachable = set(_present_seeds)
        _undirected = value.to_undirected(as_view=True)
        for _seed in _present_seeds:
            _reachable.update(__nx.single_source_shortest_path_length(
                _undirected, _seed, cutoff=${maxGraphHops}
            ))
        if set(value.nodes) - _reachable:
            raise ValueError(
                "GRAPH_FINAL contains nodes outside max_graph_hops=${maxGraphHops}; "
                "return complete paths within the configured limit"
            )
    __graph_final_result__ = __graph_to_artifact__(value)
    __graph_final_result_set__ = True
`;
  }
  return String.raw`__final_result__ = None
__final_result_set__ = False

def FINAL(x):
    global __final_result__, __final_result_set__
    __final_result__ = x
    __final_result_set__ = True
`;
}

export const GRAPH_QUERY_PY = String
  .raw`async def graph_query(context, *, graph, instruction=None):
    """Run a graph-processing child over an explicitly supplied NetworkX graph."""
    _artifact = __graph_to_artifact__(graph, globals().get("entity_index"))
    _result = await __js_graph_query__(context, _artifact, instruction)
    if hasattr(_result, "to_py"):
        _result = _result.to_py()
    if isinstance(_result, dict) and "artifact" in _result:
        _graph = __artifact_to_graph__(_result["artifact"])
        await __js_graph_query_result__(
            _result["graph_query_id"],
            type(_graph).__name__,
            _graph.number_of_nodes(),
            _graph.number_of_edges(),
        )
        print(
            f"Graph query returned {type(_graph).__name__}: "
            f"nodes={_graph.number_of_nodes()}, edges={_graph.number_of_edges()}"
        )
        if _graph.is_multigraph():
            _evidence = list(_graph.edges(keys=True, data=True))
            _evidence.sort(key=lambda _edge: (
                "office_position_or_title" in str(
                    _edge[3].get("relation", _edge[2])
                ),
                str(_edge[0]), str(_edge[1]), str(_edge[2]),
            ))
            for _u, _v, _key, _data in _evidence:
                _relation = str(_data.get("relation", _key)).rsplit(".", 1)[-1]
                print(f"{_u} -[{_relation}]-> {_v}")
        else:
            _evidence = list(_graph.edges(data=True))
            _evidence.sort(key=lambda _edge: (
                "office_position_or_title" in str(_edge[2].get("relation", "")),
                str(_edge[0]), str(_edge[1]),
            ))
            for _u, _v, _data in _evidence:
                _relation = str(_data.get("relation", "")).rsplit(".", 1)[-1]
                print(f"{_u} -[{_relation}]-> {_v}")
        return _graph
    return __artifact_to_graph__(_result)
`;

export const NEO4J_INSPECTION_PY = String.raw`import itertools as __neo4j_itertools
import json as __neo4j_json

__neo4j_scalar_row_hint__ = (
    "Return Neo4j graph values such as a, r, b, or a path for inspectable evidence."
)

def __neo4j_without_empty__(_row):
    return {
        _key: _value for _key, _value in _row.items()
        if _value is not None and _value != [] and _value != {}
    }

def __neo4j_node_fields__(_data, _include_key=None):
    _properties = _data.get("properties", {}) if isinstance(_data, dict) else {}
    _name = _properties.get("name")
    _key = _properties.get("key")
    if _name is None:
        _name = _key if _key is not None else "<unlabeled>"
    if _include_key is None:
        _include_key = globals().get("__neo4j_print_role__") == "child"
    return __neo4j_without_empty__({
        "name": _name,
        "key": _key if _include_key else None,
    })

def __neo4j_is_graph_data__(_data):
    return isinstance(_data, dict) and (
        "neo4j_element_id" in _data or
        isinstance(_data.get("properties"), dict)
    )

def __neo4j_fact__(_source_data, _target_data, _edge_data):
    _properties = _edge_data.get("properties", {})
    _predicate = _properties.get("predicate")
    if _predicate is None:
        _predicate = _edge_data.get("relation", _edge_data.get("type"))
    return {
        "source_name": __neo4j_node_fields__(_source_data, False)["name"],
        "predicate": _predicate if _predicate is not None else "<unlabeled>",
        "target_name": __neo4j_node_fields__(_target_data, False)["name"],
    }

__neo4j_node_display_by_id__ = {}
__neo4j_relationship_display_by_id__ = {}

def __neo4j_register_graph__(_graph):
    for _node_id, _data in _graph.nodes(data=True):
        _element_id = _data.get("neo4j_element_id")
        if isinstance(_element_id, str) and _node_id == _element_id:
            __neo4j_node_display_by_id__[_element_id] = (
                __neo4j_node_fields__(_data, False)["name"]
            )
    _edges = (_graph.edges(keys=True, data=True) if _graph.is_multigraph()
              else _graph.edges(data=True))
    for _edge in _edges:
        _key = _edge[2] if _graph.is_multigraph() else None
        _data = _edge[-1]
        _element_id = _data.get("neo4j_element_id")
        if (isinstance(_element_id, str) and
                (not _graph.is_multigraph() or _key == _element_id)):
            _properties = _data.get("properties", {})
            _predicate = _properties.get(
                "predicate", _data.get("relation", _data.get("type"))
            )
            __neo4j_relationship_display_by_id__[_element_id] = (
                _predicate if _predicate is not None else "<unlabeled>"
            )

def __neo4j_scalar_for_print__(_value):
    if not isinstance(_value, str):
        return _value
    if _value in __neo4j_node_display_by_id__:
        return __neo4j_node_display_by_id__[_value]
    if _value in __neo4j_relationship_display_by_id__:
        return __neo4j_relationship_display_by_id__[_value]
    return _value

def __neo4j_structured_for_print__(_value):
    if not isinstance(_value, dict):
        return _value
    _element_id = _value.get("neo4j_element_id")
    if (isinstance(_element_id, str) and
            _element_id in __neo4j_node_display_by_id__):
        return __neo4j_node_fields__(_value)
    if (isinstance(_element_id, str) and
            _element_id in __neo4j_relationship_display_by_id__):
        return {"predicate": __neo4j_relationship_display_by_id__[_element_id]}
    return _value

def neo4j_graph_snapshot(
    graph, node_limit=10, edge_limit=10, record_limit=10
):
    """Return a bounded, reasoning-oriented view of a Neo4j graph."""
    def _bounded_limit(_value, _maximum, _name):
        if isinstance(_value, bool) or not isinstance(_value, int) or _value < 0:
            raise ValueError(f"{_name} must be a non-negative integer")
        return min(_value, _maximum)

    _node_limit = _bounded_limit(node_limit, 20, "node_limit")
    _edge_limit = _bounded_limit(edge_limit, 20, "edge_limit")
    _record_limit = _bounded_limit(record_limit, 20, "record_limit")
    _role = globals().get("__neo4j_print_role__", "root")
    _all_facts = []
    _fact_seen = set()
    _fact_node_ids = []
    _edge_iter = (graph.edges(keys=True, data=True) if graph.is_multigraph()
                  else graph.edges(data=True))
    for _edge in _edge_iter:
        _source, _target = _edge[0], _edge[1]
        _data = _edge[-1]
        _fact = __neo4j_fact__(
            graph.nodes.get(_source, {}), graph.nodes.get(_target, {}), _data
        )
        _identity = tuple(_fact.values())
        if _identity in _fact_seen:
            continue
        _fact_seen.add(_identity)
        _all_facts.append(_fact)
        _fact_node_ids.append((_source, _target))
    _facts = _all_facts[:_edge_limit]
    _shown_node_ids = []
    _key_node_ids = []
    for _source, _target in _fact_node_ids[:len(_facts)]:
        if _source not in _key_node_ids:
            _key_node_ids.append(_source)
        for _node_id in (_source, _target):
            if _node_id not in _shown_node_ids:
                _shown_node_ids.append(_node_id)

    _raw_records = graph.graph.get("records", [])
    if not isinstance(_raw_records, (list, tuple)):
        _raw_records = [] if _raw_records is None else [_raw_records]
    _candidate_by_key = {}
    _candidate_node_ids = {}
    _all_scalars = []
    for _row in _raw_records:
        if not isinstance(_row, dict):
            continue
        _node_refs = [
            _value["node"] for _value in _row.values()
            if isinstance(_value, dict) and set(_value) == {"node"}
        ]
        if _node_refs and isinstance(_row.get("score"), (int, float)):
            for _node_id in _node_refs:
                _fields = __neo4j_node_fields__(graph.nodes.get(_node_id, {}), True)
                _key = _fields.get("key")
                if not isinstance(_key, str) or not _key:
                    continue
                _candidate = {
                    "name": _fields["name"], "key": _key,
                    "score": round(float(_row["score"]), 4),
                }
                _existing = _candidate_by_key.get(_key)
                if _existing is None or _candidate["score"] > _existing["score"]:
                    _candidate_by_key[_key] = _candidate
                    _candidate_node_ids[_key] = _node_id
        elif (len(_row) == 1 and
              isinstance(next(iter(_row.values())), (str, int, float, bool, type(None)))):
            _name, _value = next(iter(_row.items()))
            _all_scalars.append({"name": _name, "value": _value})
    _all_candidates = list(_candidate_by_key.values())
    _all_candidates.sort(key=lambda _item: (-_item["score"], _item["name"], _item["key"]))
    _candidates = _all_candidates[:_record_limit]
    _scalars = _all_scalars[:_record_limit]
    for _candidate in _candidates:
        _node_id = _candidate_node_ids[_candidate["key"]]
        if _node_id not in _shown_node_ids:
            _shown_node_ids.append(_node_id)

    _entities = []
    for _node_id, _data in graph.nodes(data=True):
        if _node_id in _shown_node_ids:
            continue
        _entities.append(__neo4j_node_fields__(_data, _role == "child"))
        if len(_entities) == _node_limit:
            break

    _keys = []
    if _role == "child":
        _seen_keys = {_candidate["key"] for _candidate in _candidates}
        for _node_id in _key_node_ids:
            _fields = __neo4j_node_fields__(graph.nodes.get(_node_id, {}), True)
            _key = _fields.get("key")
            if isinstance(_key, str) and _key and _key not in _seen_keys:
                _seen_keys.add(_key)
                _keys.append({"name": _fields["name"], "key": _key})
            if len(_keys) == _node_limit:
                break

    _omitted = int(graph.graph.get("omitted_scalar_records", 0) or 0)
    _snapshot = {
        "counts": {
            "nodes": graph.number_of_nodes(),
            "edges": graph.number_of_edges(),
            "records": len(_raw_records) + _omitted,
        }
    }
    if _facts:
        _snapshot["facts"] = _facts
    if _keys:
        _snapshot["keys"] = _keys
    if _candidates:
        _snapshot["candidates"] = _candidates
    if _scalars:
        _snapshot["scalars"] = _scalars
    if _entities:
        _snapshot["entities"] = _entities
    if _omitted:
        _snapshot["omitted_scalar_records"] = _omitted
        _snapshot["hint"] = __neo4j_scalar_row_hint__
    _truncated = []
    if len(_all_facts) > len(_facts):
        _truncated.append("facts")
    if len(_all_candidates) > len(_candidates):
        _truncated.append("candidates")
    if len(_all_scalars) > len(_scalars):
        _truncated.append("scalars")
    if len(graph) - len(_shown_node_ids) > len(_entities):
        _truncated.append("entities")
    if len(_keys) == _node_limit and len(_key_node_ids) > len(_keys):
        _truncated.append("keys")
    if _truncated:
        _snapshot["truncated"] = _truncated
    return _snapshot

def __neo4j_refresh_keys__(_snapshot):
    if "keys" not in _snapshot:
        return
    _names = set()
    for _fact in _snapshot.get("facts", []):
        _names.update((_fact.get("source_name"), _fact.get("target_name")))
    _names.update(_item.get("name") for _item in _snapshot.get("candidates", []))
    _snapshot["keys"] = [
        _item for _item in _snapshot["keys"] if _item.get("name") in _names
    ]
    if not _snapshot["keys"]:
        _snapshot.pop("keys", None)

def __neo4j_encoded_bytes__(_snapshot):
    if globals().get("__graph_print_encoding__", "toon") == "toon":
        _encoder = globals().get("__toon_encode__")
        if _encoder is not None:
            return _encoder(_snapshot, {"delimiter": ","}).encode("utf-8")
    return __neo4j_json.dumps(
        _snapshot, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")

def __neo4j_graph_for_print__(graph):
    _snapshot = neo4j_graph_snapshot(graph)
    _byte_limit = globals().get("__neo4j_observation_bytes__", 4096)
    while len(__neo4j_encoded_bytes__(_snapshot)) > _byte_limit:
        _removed = False
        for _section in ("scalars", "entities", "candidates", "facts"):
            if _snapshot.get(_section):
                _snapshot[_section].pop()
                if not _snapshot[_section]:
                    _snapshot.pop(_section)
                _truncated = _snapshot.setdefault("truncated", [])
                if _section not in _truncated:
                    _truncated.append(_section)
                __neo4j_refresh_keys__(_snapshot)
                _removed = True
                break
        if not _removed:
            _snapshot.pop("keys", None)
            if len(__neo4j_encoded_bytes__(_snapshot)) > _byte_limit:
                return {
                    "counts": _snapshot["counts"],
                    "truncated": ["facts", "candidates", "entities", "scalars"],
                    **({"omitted_scalar_records": _snapshot["omitted_scalar_records"],
                        "hint": __neo4j_scalar_row_hint__}
                       if _snapshot.get("omitted_scalar_records") else {}),
                }
            break
    return _snapshot

def __neo4j_view_for_print__(_view):
    _view_type = type(_view).__name__
    if "Node" in _view_type:
        _nodes = getattr(_view, "_nodes", None)
        if not isinstance(_nodes, dict) or not any(
            __neo4j_is_graph_data__(_data) for _data in _nodes.values()
        ):
            return None
        _items = []
        for _node_id in __neo4j_itertools.islice(iter(_view), 10):
            if isinstance(_node_id, tuple):
                _node_id = _node_id[0]
            _items.append(__neo4j_node_fields__(_nodes.get(_node_id, {})))
        return {"counts": {"nodes": len(_view)}, "entities": _items}
    if "Edge" in _view_type:
        _graph = getattr(_view, "_graph", None)
        if _graph is None:
            _graph = getattr(getattr(_view, "_viewer", None), "_graph", None)
        if _graph is None or not any(
            __neo4j_is_graph_data__(_data)
            for _, _, _data in _graph.edges(data=True)
        ):
            return None
        _facts = []
        _seen = set()
        for _edge in _view:
            _source, _target = _edge[0], _edge[1]
            _data = _graph.get_edge_data(_source, _target)
            if _graph.is_multigraph():
                _key = _edge[2] if len(_edge) > 2 and not isinstance(_edge[2], dict) else None
                _data = (_data.get(_key, {}) if _key is not None else
                         next(iter(_data.values()), {}))
            _fact = __neo4j_fact__(
                _graph.nodes.get(_source, {}), _graph.nodes.get(_target, {}), _data
            )
            _identity = tuple(_fact.values())
            if _identity not in _seen:
                _seen.add(_identity)
                _facts.append(_fact)
            if len(_facts) == 10:
                break
        return {"counts": {"edges": len(_view)}, "facts": _facts}
    return None

def __neo4j_collection_item_for_print__(_item):
    if not isinstance(_item, (list, tuple)):
        return _item
    if len(_item) == 2 and __neo4j_is_graph_data__(_item[1]):
        return __neo4j_node_fields__(_item[1])
    if len(_item) in (3, 4) and __neo4j_is_graph_data__(_item[-1]):
        _data = _item[-1]
        _predicate = _data.get("properties", {}).get(
            "predicate", _data.get("relation", _data.get("type"))
        )
        return {"predicate": _predicate if _predicate is not None else "<unlabeled>"}
    return _item
`;

export const NEO4J_PARAMETER_TRANSPORT_PY = String.raw`
__neo4j_integer_parameter_tag__ = "__fast_rlm_neo4j_integer__"

def __neo4j_transport_parameters__(_value):
    """Preserve Python int versus float across the Pyodide JavaScript bridge."""
    if type(_value) is int:
        return {__neo4j_integer_parameter_tag__: str(_value)}
    if isinstance(_value, dict):
        return {
            _key: __neo4j_transport_parameters__(_item)
            for _key, _item in _value.items()
        }
    if isinstance(_value, (list, tuple)):
        return [__neo4j_transport_parameters__(_item) for _item in _value]
    return _value
`;

export const NEO4J_CYPHER_PY = String.raw`${NEO4J_PARAMETER_TRANSPORT_PY}
evidence_graph = nx.MultiDiGraph()
evidence_graph.graph.update({
    "source_backend": "neo4j",
    "records": [],
    "omitted_scalar_records": 0,
    "truncated": False,
})
__neo4j_population_terms__ = {"people", "person", "inhabitants", "residents"}

def __merge_neo4j_evidence__(_target, _source):
    """Accumulate a Cypher result without degrading concrete node data."""
    _estimated_bytes = len(__neo4j_json.dumps(
        __graph_to_artifact__(_target), ensure_ascii=False
    ).encode("utf-8")) + len(__neo4j_json.dumps(
        __graph_to_artifact__(_source), ensure_ascii=False
    ).encode("utf-8"))
    if _estimated_bytes > globals().get("__neo4j_evidence_bytes__", 5242880):
        raise ValueError("evidence_graph exceeds configured byte limit")
    for _node_id, _incoming in _source.nodes(data=True):
        _incoming = dict(_incoming)
        if _node_id not in _target:
            _target.add_node(_node_id, **_incoming)
            continue
        _existing = dict(_target.nodes[_node_id])
        if _incoming.get("placeholder") and not _existing.get("placeholder"):
            continue
        _existing.update(_incoming)
        if not _incoming.get("placeholder"):
            _existing.pop("placeholder", None)
        _target.nodes[_node_id].clear()
        _target.nodes[_node_id].update(_existing)
    for _source_id, _target_id, _key, _data in _source.edges(
        keys=True, data=True
    ):
        _target.add_edge(_source_id, _target_id, key=_key, **dict(_data))
    _target.graph.setdefault("records", []).extend(
        _source.graph.get("records", [])
    )
    _target.graph["omitted_scalar_records"] = int(
        _target.graph.get("omitted_scalar_records", 0) or 0
    ) + int(_source.graph.get("omitted_scalar_records", 0) or 0)
    _target.graph["truncated"] = bool(
        _target.graph.get("truncated") or _source.graph.get("truncated")
    )
    return _target

def build_fulltext_entity_query(entity_mention):
    """Build a Lucene parameter value, not a Cypher statement."""
    _tokens = __graph_re.findall(r"\w+", str(entity_mention).casefold())
    if not _tokens:
        raise ValueError("entity mention must contain at least one word")
    return " AND ".join(f"{_token}*" for _token in _tokens[:8])

def build_fulltext_entity_queries(entity_mention):
    """Return Lucene parameter values, not Cypher statements."""
    _tokens = __graph_re.findall(r"\w+", str(entity_mention).casefold())[:8]
    if not _tokens:
        raise ValueError("entity mention must contain at least one word")
    _queries = [" AND ".join(f"{_token}*" for _token in _tokens)]
    _meaningful = [
        _token for _token in _tokens
        if _token not in __neo4j_population_terms__ and len(_token) >= 5
    ]
    if _meaningful:
        _fallback = " AND ".join(f"{_token}~1" for _token in _meaningful)
        if _fallback not in _queries:
            _queries.append(_fallback)
    return _queries

def find_neo4j_entity_seeds(
    candidate_graph, relation_graph, entity_mentions, relation_terms=(),
    max_seeds=3, min_confidence=0.75
):
    """Rerank full-text candidates by lexical and relationship evidence."""
    global __graph_seed_resolution_called__, __graph_runtime_seed_source__
    global __graph_runtime_entity_mentions__, __graph_runtime_seed_candidates__
    global __graph_runtime_candidate_count__, __graph_runtime_seeds__
    global __neo4j_verified_seed_keys__
    global __graph_runtime_seed_methods__
    __graph_seed_resolution_called__ = True
    __graph_runtime_seed_source__ = "neo4j_fulltext"

    def _normalized(_value):
        return " ".join(__graph_re.findall(r"\w+", str(_value).casefold()))

    def _meaningful_tokens(_value):
        _tokens = _normalized(_value).split()
        _filtered = [
            _token for _token in _tokens
            if _token not in __neo4j_population_terms__
        ]
        return _filtered or _tokens

    def _token_quality(_left, _right):
        if _left == _right:
            return 1.0, "exact"
        _short, _long = sorted((_left, _right), key=len)
        if len(_short) >= 3 and _long.startswith(_short):
            return 0.9, "prefix"
        _ratio = __graph_difflib.SequenceMatcher(None, _left, _right).ratio()
        return (_ratio, "fuzzy") if _ratio >= 0.78 else (0.0, "")

    _mentions = [" ".join(_meaningful_tokens(_value))
                 for _value in (entity_mentions or [])]
    _mentions = [_value for _value in _mentions if _value]
    __graph_runtime_entity_mentions__ = _mentions
    _terms = [_normalized(_value).replace(" ", "_")
              for _value in relation_terms if _normalized(_value)]

    _lucene_scores = {}
    for _row in candidate_graph.graph.get("records", []):
        _node_ref = _row.get("node")
        if isinstance(_node_ref, dict) and "node" in _node_ref:
            try:
                _lucene_scores[_node_ref["node"]] = float(_row.get("score", 0.0))
            except (TypeError, ValueError):
                pass
    _max_lucene = max(_lucene_scores.values(), default=1.0) or 1.0

    _relations_by_key = {}
    for _u, _v, _key, _data in relation_graph.edges(keys=True, data=True):
        _relation = str(_data.get("properties", {}).get(
            "predicate", _data.get("relation", _key)
        )).casefold().replace(".", "_").replace("/", "_").replace(" ", "_")
        for _node_id in (_u, _v):
            _properties = relation_graph.nodes[_node_id].get("properties", {})
            if _properties.get("key") is not None:
                _relations_by_key.setdefault(_properties["key"], []).append(_relation)

    _ranked = []
    for _node_id, _data in candidate_graph.nodes(data=True):
        _properties = _data.get("properties", {})
        _key = _properties.get("key")
        if not isinstance(_key, str) or not _key:
            continue
        _name = _normalized(_properties.get("name", ""))
        if not _name:
            continue
        _name_tokens = _name.split()
        for _mention in _mentions:
            _mention_tokens = _mention.split()
            _qualities = [max(
                (_token_quality(_token, _candidate)[0]
                 for _candidate in _name_tokens), default=0.0
            ) for _token in _mention_tokens]
            _reverse = [max(
                (_token_quality(_token, _candidate)[0]
                 for _candidate in _mention_tokens), default=0.0
            ) for _token in _name_tokens]
            _mention_coverage = sum(
                _quality >= 0.78 for _quality in _qualities
            ) / max(1, len(_qualities))
            _candidate_coverage = sum(
                _quality >= 0.78 for _quality in _reverse
            ) / max(1, len(_reverse))
            _lexical = (
                0.7 * (sum(_qualities) / max(1, len(_qualities))) +
                0.3 * _candidate_coverage
            )
            if len(_mention_tokens) > 1 and len(_name_tokens) == 1:
                _lexical *= 0.55
            _lucene = min(
                1.0, _lucene_scores.get(_node_id, 0.0) / _max_lucene
            )
            _candidate_relations = _relations_by_key.get(
                _properties.get("key"), []
            )
            _matched_terms = {
                _term for _term in _terms
                if any(_term in _relation for _relation in _candidate_relations)
            }
            _relation_score = len(_matched_terms) / max(1, len(_terms))
            _score = min(
                1.0,
                0.75 * _lexical + 0.10 * _lucene + 0.15 * _relation_score,
            )
            _methods = []
            for _token in _mention_tokens:
                _method = max(
                    (_token_quality(_token, _candidate)
                     for _candidate in _name_tokens),
                    default=(0.0, ""), key=lambda _item: _item[0],
                )[1]
                if _method:
                    _methods.append(_method)
            _ranked.append({
                "key": _key,
                "name": _properties.get("name"),
                "score": round(_score, 4),
                "method": "+".join(sorted(set(_methods))) or "none",
                "mention_coverage": round(_mention_coverage, 4),
            })
    _ranked.sort(key=lambda _item: (-_item["score"], str(_item["name"])))
    __graph_runtime_candidate_count__ = len(_ranked)
    __graph_runtime_seed_candidates__ = _ranked[:5]
    _selected = []
    _seen = set()
    for _candidate in _ranked:
        _stable_id = _candidate["key"]
        if (_candidate["score"] < min_confidence or
                _candidate["key"] is None or _stable_id in _seen):
            continue
        _seen.add(_stable_id)
        _selected.append(_candidate)
        if len(_selected) == max_seeds:
            break
    __graph_runtime_seeds__ = [
        _candidate["name"] for _candidate in _selected
    ]
    __neo4j_verified_seed_keys__ = [_candidate["key"] for _candidate in _selected]
    __graph_runtime_seed_methods__ = sorted({
        _candidate["method"] for _candidate in _selected
    })
    return _selected

async def execute_read_only_cypher(
    query, parameters=None, limit=None
):
    """Execute one bounded read-only Cypher query and return a NetworkX graph."""
    global __graph_runtime_seed_candidates__, __graph_runtime_candidate_count__
    if parameters is None:
        parameters = {}
    _result = await __js_execute_read_only_cypher__(
        query, __neo4j_transport_parameters__(parameters), limit
    )
    if hasattr(_result, "to_py"):
        _result = _result.to_py()
    _graph = __artifact_to_graph__(_result["artifact"])
    _graph.graph.setdefault("source_backend", "neo4j")
    _records = _graph.graph.get("records", [])
    if "db.index.fulltext.querynodes" in str(query).casefold():
        _candidate_names = []
        for _, _data in _graph.nodes(data=True):
            _name = _data.get("properties", {}).get("name")
            if _name is not None:
                _candidate_names.append(str(_name))
        for _row in _records:
            if _row.get("name") is not None:
                _candidate_names.append(str(_row["name"]))
        for _name in _candidate_names:
            if _name in __neo4j_seed_names_seen__:
                continue
            __neo4j_seed_names_seen__.add(_name)
            if len(__graph_runtime_seed_candidates__) < 20:
                __graph_runtime_seed_candidates__.append({
                    "name": _name,
                    "method": "neo4j_fulltext",
                })
        __graph_runtime_candidate_count__ = len(__neo4j_seed_names_seen__)
    __merge_neo4j_evidence__(evidence_graph, _graph)
    _budget = _result.get("budget", {})
    print(
        "Cypher result stored in evidence_graph: "
        f"result rows={_result.get('rows', len(_records))}, nodes={_graph.number_of_nodes()}, "
        f"edges={_graph.number_of_edges()}, "
        f"truncated={bool(_graph.graph.get('truncated'))}; "
        f"accumulated rows={len(evidence_graph.graph.get('records', [])) + int(evidence_graph.graph.get('omitted_scalar_records', 0) or 0)}, "
        f"nodes={evidence_graph.number_of_nodes()}, "
        f"edges={evidence_graph.number_of_edges()}, "
        f"truncated={bool(evidence_graph.graph.get('truncated'))}; "
        f"attempts used={_budget.get('attempts_used', '?')}, "
        f"remaining={_budget.get('attempts_remaining', '?')}"
    )
    return _graph
`;

export const NEO4J_GRAPH_QUERY_PY = String.raw`async def graph_query(context, *, instruction=None):
    """Run a graph child that retrieves bounded NetworkX evidence from Neo4j."""
    _result = await __js_graph_query__(context, instruction)
    if hasattr(_result, "to_py"):
        _result = _result.to_py()
    _graph = __artifact_to_graph__(_result["artifact"])
    _graph.graph.setdefault("source_backend", "neo4j")
    await __js_graph_query_result__(
        _result["graph_query_id"],
        type(_graph).__name__,
        _graph.number_of_nodes(),
        _graph.number_of_edges(),
    )
    print(_graph)
    return _graph
`;

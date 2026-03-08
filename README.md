# freelang-stdlib-lowdb

FreeLang v2 stdlib — `lowdb.fl` + `stdlib-lowdb.ts`

**작업지시서 #27 구현체** | npm lowdb 완전 대체 (외부 npm 0개)

## 파일

| 파일 | 줄 수 |
|------|-------|
| `lowdb.fl` | 286줄 |
| `stdlib-lowdb.ts` | 468줄 |

## path 문법

| 표현 | 의미 |
|------|------|
| `""` | 루트 전체 |
| `"users"` | 최상위 키 |
| `"users.0"` | 배열 0번 항목 |
| `"users.0.name"` | 중첩 경로 |
| `"a.b.c"` | 임의 깊이 |

## 사용 예시

```fl
import "lowdb"

var db = createWithDefault("db.json", { users: [], posts: [] })

push(db, "users", { id: 1, name: "김철수", age: 30 })
push(db, "users", { id: 2, name: "이영희", age: 25 })

var all   = get(db, "users")
var name  = get(db, "users.0.name")

set(db, "users.0.name", "박민준")

var user  = find(db, "users", "id", 1)
var young = filter(db, "users", "active", true)

update(db, "users", "id", 1, { name: "수정됨" })
upsert(db, "users", "id", 3, { id: 3, name: "신규" })

remove(db, "users.0")
write(db)
```

## 네이티브 함수 (13개)

`lowdb_create` `lowdb_get` `lowdb_set` `lowdb_push` `lowdb_remove`
`lowdb_has` `lowdb_write` `lowdb_read` `lowdb_keys` `lowdb_size`
`lowdb_find` `lowdb_filter` `lowdb_update`

---
작성일: 2026-03-09 | 작업지시서 #27

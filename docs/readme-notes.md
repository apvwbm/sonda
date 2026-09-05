# Notas para el README

Cosas decididas durante la implementación que hay que contar en el README de la
fase 9. No son pendientes de código: son decisiones cerradas que el usuario tiene
que conocer.

Complementan la lista de la sección 9 del plan, que ya recoge las trampas
generales de SQLite y Docker.

---

## `unit` no se puede cambiar después de crear la serie

`PATCH /api/series/:id` acepta solo `name` y `archived_at`. El `slug` y el
`value_type` quedan fuera porque el plan lo pide, y **`unit` también**, que es
una decisión de la implementación.

**Por qué:** cambiar `kg` por `lb` no convierte nada. Las observaciones ya
guardadas se escribieron con la unidad vieja, así que renombrarla reinterpreta
en silencio todo el histórico y las medias de `/api/stats` pasan a mezclar dos
escalas. Es el mismo argumento que para el `value_type`.

**Qué hacer si te equivocaste de unidad:** crear una serie nueva con el slug
correcto y reenviar los datos convertidos. La ingesta es idempotente, así que el
reenvío es seguro.

---

## El logout no cierra la sesión en el servidor

La sesión es una cookie firmada con HMAC que lleva su propia caducidad dentro de
la firma. No hay tabla de sesiones: el esquema de la sección 4.1 no la tiene y
añadirla costaría una migración.

**Consecuencia:** `POST /api/auth/logout` borra la cookie del navegador, y eso
cubre el caso normal. Pero una cookie que ya se hubiera copiado fuera del
navegador seguiría valiendo hasta su caducidad (30 días).

**Cómo cerrar todas las sesiones de golpe:** cambiar `SONDA_SESSION_SECRET`, o
borrar el fichero `session-secret` de `SONDA_DATA_DIR` y reiniciar. Todas las
cookies emitidas dejan de verificar al instante.

Merece la pena decirlo junto al aviso de exponer la instancia a internet.

---

## `GET /api/export` bloquea el servidor mientras dura

`better-sqlite3` es síncrono, que es justo por lo que se eligió: para un solo
usuario es lo más rápido y lo más simple de leer. El precio es que **`VACUUM
INTO` bloquea el event loop de Node durante toda la copia**. Mientras se genera
el export, el servidor no atiende ninguna otra petición.

**Cuánto es:** con una base pequeña, milisegundos. Con cientos de megas en una
Raspberry Pi, pueden ser varios segundos, y el `HEALTHCHECK` del contenedor
puede llegar a fallar durante ese rato si coincide.

**No es un bug ni algo a arreglar con un worker thread**, que traería de vuelta
la complejidad que la decisión de SQLite síncrono evita. Es una característica
de un servicio de un solo usuario, y hay que decirla:

- No conviene poner `/api/export` en un cron de cada minuto.
- Para backups automáticos, mejor la línea de `sqlite3 ... VACUUM INTO` desde
  fuera del proceso, que es lo que ya recoge la sección 10 del plan, y dejar el
  endpoint para la descarga manual.

Lo que el endpoint sí garantiza es que la copia es **consistente**: nunca lee el
`.db` vivo, y recoge también lo que aún está en el WAL sin haber hecho
checkpoint. Un `cp` del fichero no da ninguna de las dos cosas.

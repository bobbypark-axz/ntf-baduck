#!/bin/zsh
# GNU Go 3.8 → WASM 빌드. 사전 조건: 네이티브 make 완료(패턴 .c 생성됨).
set -e
SELF=$(cd "$(dirname "$0")" && pwd)
SRC=$SELF/gnugo-wasm-tree
OUT=$SRC/emout
mkdir -p $OUT

CFLAGS="-O2 -DHAVE_CONFIG_H -Wno-implicit-function-declaration -Wno-implicit-int -Wno-return-type -I$SRC -I$SRC/engine -I$SRC/patterns -I$SRC/sgf -I$SRC/utils"

UTILS=(getopt getopt1 random gg_utils)
SGF=(sgf_utils sgfnode sgftree)
ENGINE=(aftermath board boardlib breakin cache clock combination dragon endgame filllib fuseki genmove globals handicap hash influence interface matchpat montecarlo move_reasons movelist optics oracle owl persistent printutils readconnect reading semeai sgfdecide sgffile shapes showbord surround unconditional utils value_moves worm)
PATTERNS=(connections helpers transform conn patterns apatterns dpatterns eyes influence barriers endgame aa_attackpat owl_attackpat owl_vital_apat owl_defendpat fusekipat fuseki9 fuseki13 fuseki19 josekidb handipat oraclepat mcpat)

OBJS=()
for f in $UTILS; do emcc $=CFLAGS -c -o $OUT/utils_$f.o $SRC/utils/$f.c; OBJS+=$OUT/utils_$f.o; done
for f in $SGF; do emcc $=CFLAGS -c -o $OUT/sgf_$f.o $SRC/sgf/$f.c; OBJS+=$OUT/sgf_$f.o; done
for f in $ENGINE; do emcc $=CFLAGS -c -o $OUT/eng_$f.o $SRC/engine/$f.c; OBJS+=$OUT/eng_$f.o; done
for f in $PATTERNS; do emcc $=CFLAGS -c -o $OUT/pat_$f.o $SRC/patterns/$f.c; OBJS+=$OUT/pat_$f.o; done

emcc $=CFLAGS $SRC/gg_wrapper.c $OBJS -lm -Wl,--error-limit=0 \
  -O2 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createGnuGoModule \
  -s ENVIRONMENT=web,worker,node \
  -s INITIAL_MEMORY=67108864 \
  -s STACK_SIZE=33554432 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_FUNCTIONS=_gg_genmove_pos,_malloc,_free \
  -s EXPORTED_RUNTIME_METHODS=HEAPU8 \
  -o $SELF/gnugo-wasm.js
ls -la $SELF/gnugo-wasm.js $SELF/gnugo-wasm.wasm

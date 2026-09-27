export const DUEL_LANGUAGES = Object.freeze({
  python: {
    label: "Python 3.13",
    compiler: "cpython-3.13.8",
    editorLanguage: "python",
    template: `def act(n, walls, start, known_enemies, emit):
    wall_set = set(map(tuple, walls))
    row, col = start

    # 例: 壁を避けながら右方向へ進む
    for _ in range(n - 1):
        next_col = col + 1
        if next_col >= n or (row, next_col) in wall_set:
            break
        col = next_col
        emit(row, col)`,
  },
  cpp: {
    label: "GCC 13.2 · C++20",
    compiler: "gcc-13.2.0",
    editorLanguage: "cpp",
    template: `void act(int n, const vector<Position>& walls, Position start,
         const vector<Enemy>& knownEnemies, const Emit& emit) {
    set<pair<int, int>> wallSet;
    for (const auto& wall : walls) wallSet.emplace(wall.row, wall.col);
    int row = start.row, col = start.col;

    // 例: 壁を避けながら右方向へ進む
    for (int step = 0; step < n - 1; ++step) {
        int nextCol = col + 1;
        if (nextCol >= n || wallSet.contains({row, nextCol})) break;
        col = nextCol;
        emit(row, col);
    }
}`,
  },
  java: {
    label: "OpenJDK 21",
    compiler: "openjdk-jdk-21+35",
    editorLanguage: "java",
    template: `static void act(int n, List<Position> walls, Position start,
        List<Enemy> knownEnemies, Emit emit) {
    Set<Position> wallSet = new HashSet<>(walls);
    int row = start.row(), col = start.col();

    // 例: 壁を避けながら右方向へ進む
    for (int step = 0; step < n - 1; step++) {
        int nextCol = col + 1;
        if (nextCol >= n || wallSet.contains(new Position(row, nextCol))) break;
        col = nextCol;
        emit.go(row, col);
    }
}`,
  },
});

function pythonList(cells) {
  return `[${cells.map(([row, col]) => `(${row}, ${col})`).join(", ")}]`;
}

function pythonKnown(known) {
  return `[${known.map((item) => `(${item.row}, ${item.col}, ${item.activated ? "True" : "False"})`).join(", ")}]`;
}

function cppPositions(cells) {
  return `{${cells.map(([row, col]) => `{${row}, ${col}}`).join(", ")}}`;
}

function cppKnown(known) {
  return `{${known.map((item) => `{${item.row}, ${item.col}, ${item.activated ? "true" : "false"}}`).join(", ")}}`;
}

function javaPositions(cells) {
  if (!cells.length) return "List.of()";
  return `List.of(${cells.map(([row, col]) => `new Position(${row}, ${col})`).join(", ")})`;
}

function javaKnown(known) {
  if (!known.length) return "List.of()";
  return `List.of(${known.map((item) => `new Enemy(${item.row}, ${item.col}, ${item.activated})`).join(", ")})`;
}

export function buildDuelSource(language, userCode, input, nonce) {
  const size = Number(input.size);
  const walls = Array.isArray(input.walls) ? input.walls : [];
  const known = Array.isArray(input.knownEnemies) ? input.knownEnemies : [];
  const [startRow, startCol] = input.start;
  const maxOutputs = Number(input.maxOutputs || size * size * 4);
  const begin = `__GBD_${nonce}_BEGIN__`;
  const end = `__GBD_${nonce}_END__`;
  const result = `__GBD_${nonce}_RESULT__`;

  if (language === "python") {
    return `import resource
import time

${userCode}

class __GBStop(BaseException):
    pass

__gb_path = []
__gb_status = "ok"
__gb_current = [${startRow}, ${startCol}]
__gb_walls = set(${pythonList(walls)})

def __gb_emit(row, col):
    global __gb_status
    if type(row) is not int or type(col) is not int:
        __gb_status = "invalid"
        raise __GBStop()
    if len(__gb_path) >= ${maxOutputs}:
        __gb_status = "limit"
        raise __GBStop()
    if abs(__gb_current[0] - row) + abs(__gb_current[1] - col) != 1:
        __gb_status = "invalid"
        raise __GBStop()
    __gb_path.append((row, col))
    if row < 0 or row >= ${size} or col < 0 or col >= ${size}:
        __gb_status = "boundary"
        raise __GBStop()
    if (row, col) in __gb_walls:
        __gb_status = "wall"
        raise __GBStop()
    __gb_current[0], __gb_current[1] = row, col

__gb_started = time.perf_counter_ns()
try:
    act(${size}, ${pythonList(walls)}, (${startRow}, ${startCol}), ${pythonKnown(known)}, __gb_emit)
except __GBStop:
    pass
__gb_elapsed = (time.perf_counter_ns() - __gb_started) / 1_000_000
__gb_memory = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
print("${begin}")
for __gb_row, __gb_col in __gb_path:
    print(f"{__gb_row} {__gb_col}")
print("${end}")
print(f"${result} {__gb_status} {__gb_elapsed:.6f} {__gb_memory}")
`;
  }

  if (language === "cpp") {
    return `#include <bits/stdc++.h>
#include <sys/resource.h>
using namespace std;

struct Position { int row; int col; };
struct Enemy { int row; int col; bool activated; };
using Emit = function<void(int, int)>;

${userCode}

struct __GBStop {};

int main() {
    vector<pair<int, int>> path;
    path.reserve(${maxOutputs});
    string status = "ok";
    Position current{${startRow}, ${startCol}};
    const vector<Position> walls = ${cppPositions(walls)};
    const vector<Enemy> knownEnemies = ${cppKnown(known)};
    set<pair<int, int>> wallSet;
    for (const auto& wall : walls) wallSet.emplace(wall.row, wall.col);
    Emit emit = [&](int row, int col) {
        if (path.size() >= ${maxOutputs}) { status = "limit"; throw __GBStop{}; }
        if (abs(current.row - row) + abs(current.col - col) != 1) { status = "invalid"; throw __GBStop{}; }
        path.emplace_back(row, col);
        if (row < 0 || row >= ${size} || col < 0 || col >= ${size}) { status = "boundary"; throw __GBStop{}; }
        if (wallSet.contains({row, col})) { status = "wall"; throw __GBStop{}; }
        current = {row, col};
    };
    const auto started = chrono::steady_clock::now();
    try { act(${size}, walls, {${startRow}, ${startCol}}, knownEnemies, emit); }
    catch (const __GBStop&) {}
    const double elapsed = chrono::duration<double, milli>(chrono::steady_clock::now() - started).count();
    rusage usage{};
    getrusage(RUSAGE_SELF, &usage);
    cout << "${begin}\\n";
    for (const auto& [row, col] : path) cout << row << ' ' << col << '\\n';
    cout << "${end}\\n";
    cout << fixed << setprecision(6) << "${result} " << status << ' ' << elapsed << ' ' << usage.ru_maxrss << '\\n';
}
`;
  }

  const indented = userCode.split("\n").map((line) => `    ${line}`).join("\n");
  return `import java.util.*;

class Main {
    record Position(int row, int col) {}
    record Enemy(int row, int col, boolean activated) {}
    interface Emit { void go(int row, int col); }
    static final class GBStop extends Error {}

${indented}

    public static void main(String[] args) {
        List<int[]> path = new ArrayList<>(${maxOutputs});
        String[] status = {"ok"};
        int[] current = {${startRow}, ${startCol}};
        List<Position> walls = ${javaPositions(walls)};
        List<Enemy> knownEnemies = ${javaKnown(known)};
        Set<Position> wallSet = new HashSet<>(walls);
        Emit emit = (row, col) -> {
            if (path.size() >= ${maxOutputs}) { status[0] = "limit"; throw new GBStop(); }
            if (Math.abs(current[0] - row) + Math.abs(current[1] - col) != 1) { status[0] = "invalid"; throw new GBStop(); }
            path.add(new int[]{row, col});
            if (row < 0 || row >= ${size} || col < 0 || col >= ${size}) { status[0] = "boundary"; throw new GBStop(); }
            if (wallSet.contains(new Position(row, col))) { status[0] = "wall"; throw new GBStop(); }
            current[0] = row;
            current[1] = col;
        };
        Runtime runtime = Runtime.getRuntime();
        long memoryBefore = runtime.totalMemory() - runtime.freeMemory();
        long started = System.nanoTime();
        try { act(${size}, walls, new Position(${startRow}, ${startCol}), knownEnemies, emit); }
        catch (GBStop ignored) {}
        double elapsed = (System.nanoTime() - started) / 1_000_000.0;
        long memoryAfter = runtime.totalMemory() - runtime.freeMemory();
        long memoryKb = Math.max(memoryBefore, memoryAfter) / 1024;
        StringBuilder output = new StringBuilder("${begin}\\n");
        for (int[] cell : path) output.append(cell[0]).append(' ').append(cell[1]).append('\\n');
        output.append("${end}\\n");
        output.append(String.format(Locale.ROOT, "${result} %s %.6f %d\\n", status[0], elapsed, memoryKb));
        System.out.print(output);
    }
}
`;
}

export function createDuelWandboxRequest(language, source) {
  const config = DUEL_LANGUAGES[language];
  if (!config) throw new Error(`未対応の言語です: ${language}`);
  const request = { compiler: config.compiler, code: source, stdin: "", options: "", save: false };
  if (language === "cpp") request["compiler-option-raw"] = "-std=gnu++20\n-O2\n-Wall\n-Wextra";
  return request;
}

export function parseDuelOutput(output, nonce) {
  const lines = String(output || "").split(/\r?\n/);
  const beginMarker = `__GBD_${nonce}_BEGIN__`;
  const endMarker = `__GBD_${nonce}_END__`;
  const resultPrefix = `__GBD_${nonce}_RESULT__ `;
  const begin = lines.lastIndexOf(beginMarker);
  const end = lines.lastIndexOf(endMarker);
  if (begin < 0 || end <= begin) throw new Error("経路出力を取得できませんでした。");
  const path = lines.slice(begin + 1, end).filter(Boolean).map((line, index) => {
    const match = line.trim().match(/^(-?\d+)\s+(-?\d+)$/);
    if (!match) throw new Error(`経路出力の${index + 1}行目を解析できません。`);
    return [Number(match[1]), Number(match[2])];
  });
  const resultLine = lines.slice(end + 1).findLast((line) => line.startsWith(resultPrefix));
  const match = resultLine?.slice(resultPrefix.length).match(/^(ok|wall|boundary|invalid|limit)\s+([0-9.]+)\s+(\d+)$/);
  if (!match) throw new Error("実行計測値を取得できませんでした。");
  return {
    path,
    status: match[1],
    timeMs: Number(match[2]),
    memoryKb: Number(match[3]),
    userOutput: [...lines.slice(0, begin), ...lines.slice(end + 1).filter((line) => !line.startsWith(resultPrefix))]
      .filter(Boolean)
      .join("\n"),
  };
}

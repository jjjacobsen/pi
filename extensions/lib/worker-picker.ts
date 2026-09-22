import { fuzzyFilter, Input, SelectList, truncateToWidth } from "@earendil-works/pi-tui";

// Follows imagegen.ts and pi's TUI selection pattern
export function workerPicker(tui, theme, keybindings, done, title, values: string[], current) {
  const input = new Input();
  const items = values.map((value) => ({ value, label: value }));
  const listTheme = {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  };
  const createList = (filtered, selected) => {
    const list = new SelectList(filtered, Math.max(1, Math.min(12, tui.terminal.rows - 6)), listTheme);
    list.setSelectedIndex(Math.max(0, filtered.findIndex((item) => item.value === selected)));
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    return list;
  };
  let filtered = items;
  let list = createList(filtered, current);
  let rows = tui.terminal.rows;
  return {
    get focused() { return input.focused; },
    set focused(value) { input.focused = value; },
    render(width) {
      if (rows !== tui.terminal.rows) {
        rows = tui.terminal.rows;
        list = createList(filtered, list.getSelectedItem()?.value);
      }
      return [
        truncateToWidth(theme.fg("accent", title), width),
        ...input.render(width),
        ...list.render(width),
        truncateToWidth(theme.fg("dim", "Type to filter · arrows to move · Enter to save · Esc to cancel"), width),
      ];
    },
    invalidate() { input.invalidate(); list.invalidate(); },
    handleInput(data) {
      if (["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"].some((key) => keybindings.matches(data, key))) {
        list.handleInput(data);
      } else {
        const previous = input.getValue();
        input.handleInput(data);
        if (input.getValue() !== previous) {
          filtered = fuzzyFilter(items, input.getValue(), (item) => item.value);
          list = createList(filtered, list.getSelectedItem()?.value);
        }
      }
      tui.requestRender();
    },
  };
}

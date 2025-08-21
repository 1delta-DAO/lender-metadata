export type DisplayItem = {
  id: string;
  label: string;
  group?: string | null;
};

export type DisplayData = {
  items: DisplayItem[];
};

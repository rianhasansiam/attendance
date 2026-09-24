import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

// A shared UI lifecycle signal, never an authentication authority or token store.
export type WorkspaceStatus = "active" | "signed-out" | "expired" | "forbidden";
const workspaceUi = createSlice({
  name: "workspaceUi",
  initialState: { status: "active" as WorkspaceStatus },
  reducers: {
    workspaceClosed(
      state,
      action: PayloadAction<Exclude<WorkspaceStatus, "active">>,
    ) {
      if (state.status === "active") state.status = action.payload;
    },
  },
});
export const { workspaceClosed } = workspaceUi.actions;
export const workspaceUiReducer = workspaceUi.reducer;

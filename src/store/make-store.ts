import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import { baseApi } from "./api/base-api";
import {
  workspaceClosed,
  workspaceUiReducer,
} from "./features/workspace-ui/slice";

export function makeStore() {
  const lifecycle = createListenerMiddleware();
  const store = configureStore({
    reducer: {
      [baseApi.reducerPath]: baseApi.reducer,
      workspaceUi: workspaceUiReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware()
        .prepend(lifecycle.middleware)
        .concat(baseApi.middleware),
    devTools: process.env.NODE_ENV !== "production",
  });
  lifecycle.startListening({
    actionCreator: workspaceClosed,
    effect: () => clearWorkspaceData(store),
  });
  return store;
}
export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];

export function clearWorkspaceData(store: AppStore) {
  for (const task of store.dispatch(baseApi.util.getRunningQueriesThunk()))
    task.abort();
  for (const task of store.dispatch(baseApi.util.getRunningMutationsThunk()))
    task.abort();
  store.dispatch(baseApi.util.resetApiState());
}

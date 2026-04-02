#!/usr/bin/env node
/**
 * Extended Google Tasks MCP server (fork overlay for r/mcp).
 * Adds optional `due` on create_task and `update_task` (patch title / notes / due).
 * Base: mstfe/mcp-google-tasks; RFC 3339 for `due` (e.g. 2026-04-15T00:00:00.000Z).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

const { OAuth2 } = google.auth;

const GOOGLE_TASKS_API_VERSION = "v1";
const oAuth2Client = new OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI,
);

oAuth2Client.setCredentials({
  access_token: process.env.ACCESS_TOKEN,
  refresh_token: process.env.REFRESH_TOKEN,
});

const tasks = google.tasks({
  version: GOOGLE_TASKS_API_VERSION,
  auth: oAuth2Client,
});

interface CreateTaskArgs {
  title?: string;
  notes?: string;
  due?: string;
  taskId?: string;
  status?: string;
}

export function isValidCreateTaskArgs(args: unknown): args is CreateTaskArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    ((args as CreateTaskArgs).title === undefined ||
      typeof (args as CreateTaskArgs).title === "string") &&
    ((args as CreateTaskArgs).notes === undefined ||
      typeof (args as CreateTaskArgs).notes === "string") &&
    ((args as CreateTaskArgs).due === undefined ||
      typeof (args as CreateTaskArgs).due === "string") &&
    ((args as CreateTaskArgs).taskId === undefined ||
      typeof (args as CreateTaskArgs).taskId === "string") &&
    ((args as CreateTaskArgs).status === undefined ||
      typeof (args as CreateTaskArgs).status === "string")
  );
}

interface UpdateTaskArgs {
  taskId: string;
  title?: string;
  notes?: string;
  due?: string;
}

function isValidUpdateTaskArgs(args: unknown): args is UpdateTaskArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as UpdateTaskArgs;
  return (
    typeof a.taskId === "string" &&
    (a.title === undefined || typeof a.title === "string") &&
    (a.notes === undefined || typeof a.notes === "string") &&
    (a.due === undefined || typeof a.due === "string")
  );
}

class TasksServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: "google-tasks-server",
        version: "1.1.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      },
    );

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    this.setupResourceHandlers();
    this.setupToolHandlers();
  }

  private setupResourceHandlers(): void {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: "tasks://default",
          name: "Default Task List",
          mimeType: "application/json",
          description: "Manage your Google Tasks",
        },
      ],
    }));

    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        if (request.params.uri !== "tasks://default") {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Unknown resource: ${request.params.uri}`,
          );
        }

        try {
          const response = await tasks.tasks.list({
            tasklist: "@default",
          });

          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify(response.data.items, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Tasks API error: ${error}`,
          );
        }
      },
    );
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "create_task",
          description:
            "Create a new task in Google Tasks (optional due date as RFC 3339, e.g. 2026-04-15T00:00:00.000Z)",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Title of the task" },
              notes: { type: "string", description: "Notes for the task" },
              due: {
                type: "string",
                description:
                  "Due datetime (RFC 3339), e.g. 2026-04-15T00:00:00.000Z for end-of-day UTC",
              },
            },
            required: ["title"],
          },
        },
        {
          name: "list_tasks",
          description: "List all tasks in the default task list",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "delete_task",
          description: "Delete a task from the default task list",
          inputSchema: {
            type: "object",
            properties: {
              taskId: { type: "string", description: "ID of the task to delete" },
            },
            required: ["taskId"],
          },
        },
        {
          name: "complete_task",
          description: "Toggle the completion status of a task",
          inputSchema: {
            type: "object",
            properties: {
              taskId: {
                type: "string",
                description: "ID of the task to toggle completion status",
              },
              status: {
                type: "string",
                description: "Status of task, needsAction or completed",
              },
            },
            required: ["taskId"],
          },
        },
        {
          name: "update_task",
          description:
            "Update an existing task (patch). Provide taskId and at least one of title, notes, due (RFC 3339).",
          inputSchema: {
            type: "object",
            properties: {
              taskId: { type: "string", description: "ID of the task to update" },
              title: { type: "string", description: "New title" },
              notes: { type: "string", description: "New notes" },
              due: {
                type: "string",
                description: "New due datetime (RFC 3339)",
              },
            },
            required: ["taskId"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "list_tasks") {
        try {
          const response = await tasks.tasks.list({
            tasklist: "@default",
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data.items, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Tasks API error: ${error}`,
          );
        }
      }

      if (request.params.name === "create_task") {
        if (!isValidCreateTaskArgs(request.params.arguments)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Invalid arguments for create_task: title (string) required; notes and due optional strings.",
          );
        }
        const args = request.params.arguments;
        if (typeof args.title !== "string" || args.title === "") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "create_task requires a non-empty title string.",
          );
        }

        try {
          const requestBody: {
            title: string;
            notes?: string;
            due?: string;
          } = {
            title: args.title,
          };
          if (args.notes !== undefined) requestBody.notes = args.notes;
          if (args.due !== undefined && args.due !== "") {
            requestBody.due = args.due;
          }

          const response = await tasks.tasks.insert({
            tasklist: "@default",
            requestBody,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Tasks API error: ${error}`,
          );
        }
      }

      if (request.params.name === "delete_task") {
        if (!isValidCreateTaskArgs(request.params.arguments)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Invalid arguments for delete_task.",
          );
        }
        const args = request.params.arguments;
        const taskId = args.taskId;
        if (!taskId) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "The 'taskId' field is required.",
          );
        }
        try {
          await tasks.tasks.delete({
            tasklist: "@default",
            task: taskId,
          });

          return {
            content: [
              {
                type: "text",
                text: "Task deleted successfully.",
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Tasks API error: ${error}`,
          );
        }
      }

      if (request.params.name === "complete_task") {
        if (!isValidCreateTaskArgs(request.params.arguments)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Invalid arguments for complete_task.",
          );
        }
        const args = request.params.arguments;
        const taskId = args.taskId;
        const newStatus = args.status;

        if (!taskId) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "The 'taskId' field is required.",
          );
        }

        try {
          const updateResponse = await tasks.tasks.patch({
            tasklist: "@default",
            task: taskId,
            requestBody: { status: newStatus },
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(updateResponse.data, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Tasks API error: ${error}`,
          );
        }
      }

      if (request.params.name === "update_task") {
        if (!isValidUpdateTaskArgs(request.params.arguments)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Invalid arguments for update_task: taskId required; title, notes, due optional strings.",
          );
        }
        const args = request.params.arguments;

        const requestBody: Record<string, string> = {};
        if (args.title !== undefined) requestBody.title = args.title;
        if (args.notes !== undefined) requestBody.notes = args.notes;
        if (args.due !== undefined) {
          requestBody.due = args.due;
        }

        if (Object.keys(requestBody).length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Provide at least one of title, notes, or due to update.",
          );
        }

        try {
          const updateResponse = await tasks.tasks.patch({
            tasklist: "@default",
            task: args.taskId,
            requestBody,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(updateResponse.data, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Tasks API error: ${error}`,
          );
        }
      }

      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`,
      );
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Google Tasks MCP server running on stdio");
  }
}

const server = new TasksServer();
server.run().catch(console.error);

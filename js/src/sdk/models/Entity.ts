import { ConnectionRequest } from "./connectedAccounts";
import { Actions } from "./actions";
import { Apps } from "./apps";
import { Integrations } from "./integrations";
import { ActiveTriggers } from "./activeTriggers";
import { ConnectedAccounts } from "./connectedAccounts";
import { BackendClient } from "./backendClient";
import { Triggers } from "./triggers";
import { CEG } from "../utils/error";
import logger from "../../utils/logger";
import { SDK_ERROR_CODES } from "../utils/errors/src/constants";
import { z } from "zod";

const LABELS = {
  PRIMARY: "primary",
};

const ZExecuteActionParams = z.object({
  actionName: z.string(),
  params: z.record(z.any()).optional(),
  text: z.string().optional(),
  connectedAccountId: z.string().optional(),
});

type TExecuteActionParams = z.infer<typeof ZExecuteActionParams>;

const ZInitiateConnectionParams = z.object({
  appName: z.string(),
  authConfig: z.record(z.any()).optional(),
  integrationId: z.string().optional(),
  authMode: z.string().optional(),
  connectionData: z.record(z.any()).optional(),
  config: z
    .object({
      labels: z.array(z.string()).optional(),
      redirectUrl: z.string().optional(),
    })
    .optional(),
});

type TInitiateConnectionParams = z.infer<typeof ZInitiateConnectionParams>;

export class Entity {
  id: string;
  backendClient: BackendClient;
  triggerModel: Triggers;
  actionsModel: Actions;
  apps: Apps;
  connectedAccounts: ConnectedAccounts;
  integrations: Integrations;
  activeTriggers: ActiveTriggers;

  constructor(backendClient: BackendClient, id: string = "default") {
    this.backendClient = backendClient;
    this.id = id;
    this.triggerModel = new Triggers(this.backendClient);
    this.actionsModel = new Actions(this.backendClient);
    this.apps = new Apps(this.backendClient);
    this.connectedAccounts = new ConnectedAccounts(this.backendClient);
    this.integrations = new Integrations(this.backendClient);
    this.activeTriggers = new ActiveTriggers(this.backendClient);
  }

  async execute({
    actionName,
    params,
    text,
    connectedAccountId,
  }: TExecuteActionParams) {
    try {
      ZExecuteActionParams.parse({
        actionName,
        params,
        text,
        connectedAccountId,
      });
      const action = await this.actionsModel.get({
        actionName: actionName,
      });
      if (!action) {
        throw new Error(`Could not find action: ${actionName}`);
      }
      const app = await this.apps.get({
        appKey: action.appKey!,
      });
      if ((app.yaml as any).no_auth) {
        return this.actionsModel.execute({
          actionName: actionName,
          requestBody: {
            input: params,
            appName: action.appKey,
          },
        });
      }
      const connectedAccount = await this.getConnection({
        app: action.appKey,
        connectedAccountId,
      });

      if (!connectedAccount) {
        throw CEG.getCustomError(
          SDK_ERROR_CODES.SDK.NO_CONNECTED_ACCOUNT_FOUND,
          {
            message: `Could not find a connection with app='${action.appKey}' and entity='${this.id}'`,
            description: `Could not find a connection with app='${action.appKey}' and entity='${this.id}'`,
          }
        );
      }
      return this.actionsModel.execute({
        actionName: actionName,
        requestBody: {
          // @ts-ignore
          connectedAccountId: connectedAccount?.id as unknown as string,
          input: params,
          appName: action.appKey,
          text: text,
        },
      });
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async getConnection({
    app,
    connectedAccountId,
  }: {
    app?: string;
    connectedAccountId?: string;
  }): Promise<any | null> {
    try {
      if (connectedAccountId) {
        return await this.connectedAccounts.get({
          connectedAccountId,
        });
      }

      let latestAccount = null;
      let latestCreationDate: Date | null = null;
      const connectedAccounts = await this.connectedAccounts.list({
        // @ts-ignore
        user_uuid: this.id,
      });

      if (!connectedAccounts.items || connectedAccounts.items.length === 0) {
        return null;
      }

      for (const account of connectedAccounts.items!) {
        if (account?.labels && account?.labels.includes(LABELS.PRIMARY)) {
          latestAccount = account;
          break;
        }
      }
      if (!latestAccount) {
        for (const connectedAccount of connectedAccounts.items!) {
          if (
            app?.toLocaleLowerCase() ===
            connectedAccount.appName.toLocaleLowerCase()
          ) {
            const creationDate = new Date(connectedAccount.createdAt!);
            if (
              (!latestAccount ||
                (latestCreationDate && creationDate > latestCreationDate)) &&
              connectedAccount.status === "ACTIVE"
            ) {
              latestCreationDate = creationDate;
              latestAccount = connectedAccount;
            }
          }
        }
      }
      if (!latestAccount) {
        return null;
      }

      return this.connectedAccounts.get({
        connectedAccountId: latestAccount.id!,
      });
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async setupTrigger(
    app: string,
    triggerName: string,
    config: { [key: string]: any }
  ) {
    try {
      const connectedAccount = await this.getConnection({ app });
      if (!connectedAccount) {
        throw CEG.getCustomError(
          SDK_ERROR_CODES.SDK.NO_CONNECTED_ACCOUNT_FOUND,
          {
            description: `Could not find a connection with app='${app}' and entity='${this.id}'`,
          }
        );
      }
      const trigger = await this.triggerModel.setup({
        connectedAccountId: connectedAccount.id!,
        triggerName,
        config,
      });
      return trigger;
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async disableTrigger(triggerId: string) {
    try {
      await this.activeTriggers.disable({ triggerId: triggerId });
      return { status: "success" };
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async getConnections() {
    /**
     * Get all connections for an entity.
     */
    try {
      const connectedAccounts = await this.connectedAccounts.list({
        // @ts-ignore
        user_uuid: this.id,
      });
      return connectedAccounts.items!;
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async getActiveTriggers() {
    /**
     * Get all active triggers for an entity.
     */
    try {
      const connectedAccounts = await this.getConnections();
      const activeTriggers = await this.activeTriggers.list({
        // @ts-ignore
        connectedAccountIds: connectedAccounts!
          .map((account: any) => account.id!)
          .join(","),
      });
      return activeTriggers;
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async initiateConnection(
    data: TInitiateConnectionParams
  ): Promise<ConnectionRequest> {
    try {
      const { appName, authMode, authConfig, integrationId, connectionData } =
        ZInitiateConnectionParams.parse(data);
      const { redirectUrl, labels } = data.config || {};

      // Get the app details from the client
      const app = await this.apps.get({ appKey: appName });

      const isTestConnectorAvailable =
        app.testConnectors && app.testConnectors.length > 0;

      if (!isTestConnectorAvailable && app.no_auth === false) {
        if (!authMode) {
          // @ts-ignore
          logger.debug(
            "Auth schemes not provided, available auth schemes and authConfig"
          );
          // @ts-ignore
          for (const authScheme of app.auth_schemes) {
            // @ts-ignore
            logger.debug(
              "autheScheme:",
              authScheme.name,
              "\n",
              "fields:",
              authScheme.fields
            );
          }

          throw new Error(`Please pass authMode and authConfig.`);
        }
      }

      const timestamp = new Date().toISOString().replace(/[-:.]/g, "");

      let integration = integrationId
        ? await this.integrations.get({ integrationId: integrationId })
        : null;
      // Create a new integration if not provided
      if (!integration && authMode) {
        integration = await this.integrations.create({
          appId: app.appId!,
          name: `integration_${timestamp}`,
          authScheme: authMode,
          authConfig: authConfig,
          useComposioAuth: false,
        });
      }

      if (!integration && !authMode) {
        integration = await this.integrations.create({
          appId: app.appId!,
          name: `integration_${timestamp}`,
          useComposioAuth: true,
        });
      }

      // Initiate the connection process
      return this.connectedAccounts.initiate({
        integrationId: integration!.id!,
        entityId: this.id,
        redirectUri: redirectUrl,
        //@ts-ignore
        data: connectionData,
        labels: labels,
      });
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }
}

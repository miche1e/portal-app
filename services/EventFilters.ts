import {
  CloseRecurringPaymentResponse,
  RecurringPaymentRequest,
  RecurringPaymentResponseContent,
  SinglePaymentRequest,
  PaymentStatus,
  parseCalendar,
  parseBolt11,
  Currency_Tags,
  NostrConnectResponseStatus,
  NostrConnectMethod,
  keyToHex,
  PortalAppInterface,
} from 'portal-app-lib';
import * as Notifications from 'expo-notifications';
import { DatabaseService, fromUnixSeconds, SubscriptionWithDates } from './DatabaseService';
import { CurrencyConversionService } from './CurrencyConversionService';
import { globalEvents, PendingRequest } from '@/utils/common';
import { Currency, CurrencyHelpers, normalizeCurrencyForComparison } from '@/utils/currency';
import { getMethodString } from '@/utils/nip46';
import { Task } from '@/queue/WorkQueue';
import { SignMessageRequest } from '@breeztech/breez-sdk-spark-react-native';
import { WaitForRelaysConnectedTask } from '@/queue/tasks/WaitForRelaysConnected';
import { PromptUserProvider } from '@/queue/providers/PromptUser';
import { GetWalletInfoTask } from '@/queue/tasks/GetWalletInfo';
import { SaveActivityTask } from '@/queue/tasks/SaveActivity';
import { StartPaymentTask } from '@/queue/tasks/StartPayment';


/**
 * Sends a local notification for payment-related events with human-readable formatting
 * @param title - Notification title
 * @param amount - Payment amount
 * @param currency - Currency string (e.g., 'sats', 'USD')
 * @param serviceName - Name of the service
 * @param convertedAmount - Optional converted amount in user's preferred currency
 * @param convertedCurrency - Optional converted currency
 */
async function sendPaymentNotification(
  title: string,
  amount: number,
  currency: string,
  serviceName: string
): Promise<void> {
  try {
    // Format the amount - prefer converted amount if available
    let formattedAmount: string;
    // Use converted amount with proper formatting
    const currencyEnum = currency as Currency;
    const symbol = CurrencyHelpers.getSymbol(currencyEnum);

    if (currencyEnum === Currency.SATS) {
      formattedAmount = `${Math.round(amount)} ${symbol}`;
    } else if (currencyEnum === Currency.BTC) {
      const fixed = amount.toFixed(8);
      const trimmed = fixed.replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
      formattedAmount = `${symbol}${trimmed}`;
    } else {
      formattedAmount = `${symbol}${amount.toFixed(2)}`;
    }
    const body = `${serviceName}: ${formattedAmount}`;

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: {
          type: 'payment',
        },
      },
      trigger: null, // Show immediately
    });
  } catch (error) {
    // Silently fail - notification errors shouldn't break payment flow
    console.error('Failed to send payment notification:', error);
  }
}

export async function handleCloseRecurringPaymentResponse(
  response: CloseRecurringPaymentResponse,
  executeOperation: <T>(operation: (db: DatabaseService) => Promise<T>, fallback?: T) => Promise<T>,
  resolve: () => void
): Promise<boolean> {
  try {
    await executeOperation(
      db => db.updateSubscriptionStatus(response.content.subscriptionId, 'cancelled'),
      null
    );

    // Refresh UI to reflect the subscription status change
    console.log('Refreshing subscriptions UI after subscription closure');
    // Use the global event emitter to notify ActivitiesProvider
    globalEvents.emit('subscriptionStatusChanged', {
      subscriptionId: response.content.subscriptionId,
      status: 'cancelled',
    });
  } catch (error) {
    console.error('Error setting closed recurring payment', error);
  }

  resolve();
  return false;
}

export async function handleNostrConnectRequest(
  event: NostrConnectRequestEvent,
  signerPubkey: String,
  executeOperation: <T>(operation: (db: DatabaseService) => Promise<T>, fallback?: T) => Promise<T>,
  resolve: (status: NostrConnectResponseStatus) => void
): Promise<boolean> {
  console.log(event);
  if (event.method == NostrConnectMethod.Connect) {
    const eventSignerPubkey = event.params.at(0);
    if (!eventSignerPubkey) {
      console.log('Automatically declining request. No params');
      resolve(
        new NostrConnectResponseStatus.Declined({
          reason: 'No params',
        })
      );
      return false;
    }

    if (eventSignerPubkey !== signerPubkey) {
      console.log(
        'Automatically declining request. Connect request contains a pubkey different from this signer'
      );
      resolve(
        new NostrConnectResponseStatus.Declined({
          reason: 'Connect request contains a pubkey different from this signer',
        })
      );
      return false;
    }

    const secret = event.params.at(1);
    if (!secret) {
      console.log('Automatically declining request. Secret param is undefined');
      resolve(
        new NostrConnectResponseStatus.Declined({
          reason: 'Secret param is undefined',
        })
      );
      return false;
    }
    const secretRecord = await executeOperation(db => db.getBunkerSecretOrNull(secret));
    let isSecretInvalid: boolean = secretRecord?.used ?? true;

    if (isSecretInvalid) {
      console.log('Automatically declining request. Secret param is invalid');
      resolve(
        new NostrConnectResponseStatus.Declined({
          reason: 'Secret param is invalid',
        })
      );
      return false;
    }

    await executeOperation(db => db.markBunkerSecretAsUsed(secret));

    return true;
  }

  try {
    const hexPubkey = keyToHex(event.nostrClientPubkey);
    const nostrClient = await executeOperation(db => db.getBunkerClientOrNull(hexPubkey));
    // check that the key is abilitated and not revoked
    if (!nostrClient || nostrClient.revoked) {
      console.log(
        'Automatically declining request. Nostr client is not whitelisted or is revoked.'
      );
      resolve(
        new NostrConnectResponseStatus.Declined({
          reason: 'Nostr client is not whitelisted or is revoked.',
        })
      );
      return false;
    }

    // check that the method has a granted permission
    const permissions = nostrClient.granted_permissions
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    // getting method specific permissions with paramethers
    const methodString = getMethodString(event.method);
    const eventSpecificPermissions = permissions.filter(p => p.startsWith(methodString));

    // rejecting if there's none
    if (eventSpecificPermissions.length === 0) {
      console.log(`Automatically declining request. '${methodString}' permission not granted.`);
      resolve(
        new NostrConnectResponseStatus.Declined({
          reason: `'${methodString}' permission not granted`,
        })
      );
      return false;
    }

    // given that this method has a permission granted continue with specific logic for sign_event
    // sign_event is special because we also need to check that we can sign that specific event kind
    if (event.method == NostrConnectMethod.SignEvent) {
      // Check if permission is exactly "sign_event" (allows all kinds) or has specific kinds like "sign_event:1"
      const isUnrestricted =
        eventSpecificPermissions.length === 1 && eventSpecificPermissions[0] === methodString;
      if (!isUnrestricted) {
        // grabbing the event to sign and checking if exists
        const serializedEventToSign = event.params.at(0);
        console.log('Permission to sign event is granted. The event is:');
        console.log(serializedEventToSign);

        if (!serializedEventToSign) {
          console.log('Automatically declining request. No event to sign in the parameters.');
          resolve(
            new NostrConnectResponseStatus.Declined({
              reason: 'No event to sign in the parameters.',
            })
          );
          return false;
        }

        // getting the kind and checking if is allowed
        const eventToSignObj = JSON.parse(serializedEventToSign);
        const eventToSignKind = eventToSignObj.kind;
        if (!eventToSignKind) {
          console.log('Automatically declining request. Event to sign has no kind');
          resolve(
            new NostrConnectResponseStatus.Declined({
              reason: 'No event to sign in the parameters. Event to sign has no kind',
            })
          );
          return false;
        }

        // Extract specific allowed kinds from permissions like "sign_event:1", "sign_event:2"
        const allowedKinds = eventSpecificPermissions.map(p => p.replace('sign_event:', ''));

        const eventToSignKindStr = String(eventToSignKind);
        if (!allowedKinds.includes(eventToSignKindStr)) {
          console.log(
            `Automatically declining request. Event kind ${eventToSignKind} is not in allowed kinds: ${allowedKinds.join(', ')}`
          );
          resolve(
            new NostrConnectResponseStatus.Declined({
              reason: `Event kind ${eventToSignKind} is not permitted. Allowed kinds: ${allowedKinds.join(', ')}`,
            })
          );
          return false;
        }
      }
    }

    await executeOperation(async db => {
      await db.updateBunkerClientLastSeen(hexPubkey);
      await db.addActivity({
        type: 'auth',
        service_key: event.nostrClientPubkey,
        detail: `Approved nostr activity for: ${methodString}`,
        date: new Date(),
        service_name: nostrClient.client_name ?? 'Nostr client',
        amount: null,
        currency: null,
        converted_amount: null,
        converted_currency: null,
        request_id: event.id,
        subscription_id: null,
        status: 'positive',
      });
    }, null);
    // Nostr client is whitelisted, automatically approving the request.
    console.log(`Approving the request for method: ${event.method}`);
    resolve(new NostrConnectResponseStatus.Approved());
  } catch (e) {
    console.error(`Error while checking client permissions: ${e}`);
    resolve(
      new NostrConnectResponseStatus.Declined({
        reason: 'Error while checking client permissions',
      })
    );
  }
  return false;
}

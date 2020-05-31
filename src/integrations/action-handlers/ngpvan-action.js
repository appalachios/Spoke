import { getConfig } from "../../server/api/lib/config";
import Van from "../contact-loaders/ngpvan/util";
import { log } from "../../lib";

import httpRequest from "../../server/lib/http-request.js";

export const name = "ngpvan-action";

// What the user sees as the option
export const displayName = () => "NGPVAN action";

// The Help text for the user after selecting the action
export const instructions = () =>
  `
  This action is for reporting the results of interactions with contacts to NGPVAN
  `;

export function serverAdministratorInstructions() {
  return {
    description:
      "This action is for reporting the results of interactions with contacts to NGPVAN",
    setupInstructions:
      "Get an APP name and API key for your VAN account. Add them to your config, along with NGP_VAN_WEBHOOK_BASE_URL. In most cases the defaults for the other environment variables will work",
    environmentVariables: [
      "NGP_VAN_API_KEY",
      "NGP_VAN_API_BASE_URL",
      "NGP_VAN_APP_NAME",
      "NGP_VAN_ACTION_HANDLER_CACHE_TTL"
    ]
  };
}

export const DEFAULT_NGP_VAN_CONTACT_TYPE = "SMS Text";
export const DEFAULT_NGP_VAN_INPUT_TYPE = "API";
export const DEFAULT_NGP_VAN_ACTION_HANDLER_CACHE_TTL = 600;

export function clientChoiceDataCacheKey(organization) {
  return `${organization.id}`;
}

// return true, if the action is usable and available for the organizationId
// Sometimes this means certain variables/credentials must be setup
// either in environment variables or organization.features json data
// Besides this returning true, "test-action" will also need to be added to
// process.env.ACTION_HANDLERS
export async function available(organization) {
  const result =
    !!getConfig("NGP_VAN_API_KEY", organization) &&
    !!getConfig("NGP_VAN_APP_NAME", organization);

  if (!result) {
    log.info(
      "ngpvan contact loader unavailable. Missing one or more required environment variables."
    );
  }

  return {
    result,
    expiresSeconds: 86400
  };
}

// What happens when a texter saves the answer that triggers the action
// This is presumably the meat of the action
export async function processAction(
  questionResponse,
  interactionStep,
  campaignContactId,
  contact,
  campaign,
  organization
) {
  try {
    const answerActionsData = JSON.parse(
      (interactionStep || {}).answer_actions_data || "{}"
    );

    const body = JSON.parse(answerActionsData.value);

    const url = Van.makeUrl(
      `v4/people/${contact.external_id}/canvassResponses`,
      organization
    );

    log.info("Sending contact update to VAN", {
      vanId: contact.external_id,
      body
    });

    await httpRequest(url, {
      method: "POST",
      retries: 0,
      timeout: 5000,
      headers: {
        Authorization: Van.getAuth(organization),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      validStatuses: [204],
      compress: false
    });
  } catch (caughtError) {
    log.error("Encountered exception in ngpvan.processAction", caughtError);
    throw caughtError;
  }
}

export async function getClientChoiceData(organization) {
  const contactTypesPromise = httpRequest(
    `https://api.securevan.com/v4/canvassResponses/contactTypes`,
    {
      method: "GET",
      headers: {
        Authorization: Van.getAuth(organization)
      }
    }
  )
    .then(async response => await response.json())
    .catch(error => {
      const message = `Error retrieving contact types from VAN ${error}`;
      log.error(message);
      throw new Error(message);
    });

  const inputTypesPromise = httpRequest(
    `https://api.securevan.com/v4/canvassResponses/inputTypes`,
    {
      method: "GET",
      headers: {
        Authorization: Van.getAuth(organization)
      }
    }
  )
    .then(async response => await response.json())
    .catch(error => {
      const message = `Error retrieving input types from VAN ${error}`;
      log.error(message);
      throw new Error(message);
    });

  let contactTypeId;
  let inputTypeId;

  try {
    const [contactTypesResponse, inputTypesResponse] = await Promise.all([
      contactTypesPromise,
      inputTypesPromise
    ]);

    const contactType =
      getConfig("NGP_VAN_CONTACT_TYPE", organization) ||
      DEFAULT_NGP_VAN_CONTACT_TYPE;
    ({ contactTypeId } = contactTypesResponse.find(
      ct => ct.name === contactType
    ));
    if (!contactTypeId) {
      log.error(`Contact type ${contactType} not returned by VAN`);
    }

    const inputType =
      getConfig("NGP_VAN_INPUT_TYPE", organization) ||
      DEFAULT_NGP_VAN_INPUT_TYPE;
    ({ inputTypeId } = inputTypesResponse.find(
      inTy => inTy.name === inputType
    ));
    if (!inputTypeId) {
      log.error(`Input type ${inputType} not returned by VAN`);
    }

    if (!inputTypeId || !contactTypeId) {
      throw new Error(
        "VAN did not return the configured input type or contact type. Check the log"
      );
    }
  } catch (caughtError) {
    log.error(
      `Error loading canvass/contactTypes or canvass/inputTypes from VAN  ${caughtError}`
    );
    return {
      data: `${JSON.stringify({
        error:
          "Failed to load canvass/contactTypes or canvass/inputTypes from VAN"
      })}`
    };
  }

  const cycle = await getConfig("NGP_VAN_ELECTION_CYCLE_FILTER", organization);
  const cycleFilter = (cycle && `&cycle=${cycle}`) || "";
  const surveyQuestionsPromise = httpRequest(
    `https://api.securevan.com/v4/surveyQuestions?statuses=Active${cycleFilter}`,
    {
      method: "GET",
      headers: {
        Authorization: Van.getAuth(organization)
      }
    }
  )
    .then(async response => await response.json())
    .catch(error => {
      const message = `Error retrieving survey questions from VAN ${error}`;
      log.error(message);
      throw new Error(message);
    });

  const activistCodesPromise = httpRequest(
    `https://api.securevan.com/v4/activistCodes?statuses=Active`,
    {
      method: "GET",
      headers: {
        Authorization: Van.getAuth(organization)
      }
    }
  )
    .then(async response => await response.json())
    .catch(error => {
      const message = `Error retrieving activist codes from VAN ${error}`;
      log.error(message);
      throw new Error(message);
    });

  const canvassResultCodesPromise = httpRequest(
    `https://api.securevan.com/v4/canvassResponses/resultCodes`,
    {
      method: "GET",
      headers: {
        Authorization: Van.getAuth(organization)
      }
    }
  )
    .then(async response => await response.json())
    .catch(error => {
      const message = `Error retrieving canvass result codes from VAN ${error}`;
      log.error(message);
      throw new Error(message);
    });

  let surveyQuestionsResponse;
  let activistCodesResponse;
  let canvassResponsesResultCodesResponse;

  try {
    [
      surveyQuestionsResponse,
      activistCodesResponse,
      canvassResponsesResultCodesResponse
    ] = await Promise.all([
      surveyQuestionsPromise,
      activistCodesPromise,
      canvassResultCodesPromise
    ]);
  } catch (caughtError) {
    log.error(
      `Error loading surveyQuestions, activistCodes or canvass/resultCodes from VAN  ${caughtError}`
    );
    return {
      data: `${JSON.stringify({
        error:
          "Failed to load surveyQuestions, activistCodes or canvass/resultCodes from VAN"
      })}`
    };
  }

  const buildPayload = responseBody =>
    JSON.stringify({
      canvassContext: {
        contactTypeId,
        inputTypeId
      },
      ...responseBody
    });

  const surveyResponses = surveyQuestionsResponse.items.reduce(
    (accumulator, surveyQuestion) => {
      const responses = surveyQuestion.responses.map(surveyResponse => ({
        name: `${surveyQuestion.name} - ${surveyResponse.name}`,
        details: buildPayload({
          responses: [
            {
              type: "SurveyResponse",
              surveyQuestionId: surveyQuestion.surveyQuestionId,
              surveyResponseId: surveyResponse.surveyResponseId
            }
          ]
        })
      }));
      accumulator.push(...responses);
      return accumulator;
    },
    []
  );

  const activistCodes = activistCodesResponse.items.map(activistCode => ({
    name: activistCode.name,
    details: buildPayload({
      responses: [
        {
          type: "ActivistCode",
          action: "Apply",
          activistCodeId: activistCode.activistCodeId
        }
      ]
    })
  }));

  const canvassResponses = canvassResponsesResultCodesResponse.map(
    canvassResponse => ({
      name: canvassResponse.name,
      details: buildPayload({
        resultCodeId: canvassResponse.resultCodeId
      })
    })
  );

  const vanActions = [];
  vanActions.push(...surveyResponses, ...activistCodes, ...canvassResponses);

  return {
    data: `${JSON.stringify({ items: vanActions })}`,
    expiresSeconds:
      Number(getConfig("NGP_VAN_ACTION_HANDLER_CACHE_TTL", organization)) ||
      DEFAULT_NGP_VAN_ACTION_HANDLER_CACHE_TTL
  };
}
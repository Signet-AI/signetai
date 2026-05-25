#include "SignetUnrealClient.h"

#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Json.h"
#include "SignetUnrealSettings.h"

namespace
{
FString SerializeJsonObject(const TSharedRef<FJsonObject>& Object)
{
	FString Output;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Object, Writer);
	return Output;
}

TSharedPtr<FJsonObject> ParseJsonObject(const FString& Body)
{
	TSharedPtr<FJsonObject> Parsed;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Body);
	if (FJsonSerializer::Deserialize(Reader, Parsed))
	{
		return Parsed;
	}
	return nullptr;
}
}

FString FSignetUnrealClient::BuildWorldScope(const FString& WorldId)
{
	return FString::Printf(TEXT("world:%s"), *WorldId);
}

FString FSignetUnrealClient::BuildPlayerScope(const FString& WorldId, const FString& PlayerId)
{
	return FString::Printf(TEXT("world:%s:player:%s"), *WorldId, *PlayerId);
}

FString FSignetUnrealClient::NormalizeBaseUrl(const FString& BaseUrl)
{
	FString Normalized = BaseUrl.TrimStartAndEnd();
	while (Normalized.EndsWith(TEXT("/")))
	{
		Normalized.LeftChopInline(1);
	}
	return Normalized.IsEmpty() ? TEXT("http://127.0.0.1:3850") : Normalized;
}

FString FSignetUnrealClient::BuildUrl(const FString& Path)
{
	const USignetUnrealSettings* Settings = GetDefault<USignetUnrealSettings>();
	const FString BaseUrl = NormalizeBaseUrl(Settings ? Settings->DaemonUrl : FString());
	if (Path.StartsWith(TEXT("/")))
	{
		return BaseUrl + Path;
	}
	return BaseUrl + TEXT("/") + Path;
}

void FSignetUnrealClient::GetJson(const FString& Path, FJsonResponseHandler Handler)
{
	SendJsonRequest(TEXT("GET"), Path, FString(), Handler);
}

void FSignetUnrealClient::PostJson(
	const FString& Path,
	const TSharedRef<FJsonObject>& Body,
	FJsonResponseHandler Handler
)
{
	SendJsonRequest(TEXT("POST"), Path, SerializeJsonObject(Body), Handler);
}

void FSignetUnrealClient::SendJsonRequest(
	const FString& Method,
	const FString& Path,
	const FString& Body,
	FJsonResponseHandler Handler
)
{
	const TSharedRef<FJsonResponseHandler> SharedHandler = MakeShared<FJsonResponseHandler>(MoveTemp(Handler));
	const USignetUnrealSettings* Settings = GetDefault<USignetUnrealSettings>();
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(BuildUrl(Path));
	Request->SetVerb(Method);
	Request->SetHeader(TEXT("Accept"), TEXT("application/json"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	if (Settings && !Settings->BearerToken.IsEmpty())
	{
		Request->SetHeader(TEXT("Authorization"), FString::Printf(TEXT("Bearer %s"), *Settings->BearerToken));
	}
	if (Settings && Settings->RequestTimeoutSeconds > 0.0f)
	{
		Request->SetTimeout(Settings->RequestTimeoutSeconds);
	}
	if (!Body.IsEmpty())
	{
		Request->SetContentAsString(Body);
	}

	Request->OnProcessRequestComplete().BindLambda(
		[SharedHandler](
			FHttpRequestPtr RequestPtr,
			FHttpResponsePtr Response,
			bool bConnectedSuccessfully
		) mutable
		{
			FSignetOperationResult Result;
			Result.bSuccess = bConnectedSuccessfully && Response.IsValid() && EHttpResponseCodes::IsOk(Response->GetResponseCode());
			Result.StatusCode = Response.IsValid() ? Response->GetResponseCode() : 0;
			Result.ResponseBody = Response.IsValid() ? Response->GetContentAsString() : FString();

			if (!bConnectedSuccessfully)
			{
				Result.Error = TEXT("Could not connect to Signet daemon");
			}
			else if (!Response.IsValid())
			{
				Result.Error = TEXT("Signet daemon returned no response");
			}
			else if (!EHttpResponseCodes::IsOk(Response->GetResponseCode()))
			{
				Result.Error = FString::Printf(TEXT("Signet daemon returned HTTP %d"), Response->GetResponseCode());
			}

			(*SharedHandler)(Result, ParseJsonObject(Result.ResponseBody));
		}
	);

	if (!Request->ProcessRequest())
	{
		FSignetOperationResult Result;
		Result.Error = TEXT("Failed to start Signet HTTP request");
		(*SharedHandler)(Result, nullptr);
	}
}

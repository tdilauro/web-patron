/** @jsx jsx */
import { jsx } from "theme-ui";
import * as React from "react";
import Button from "./Button";
import useTypedSelector from "../hooks/useTypedSelector";
import { useForm, OnSubmit } from "react-hook-form";
import FormInput from "./form/FormInput";
import { useActions } from "opds-web-client/lib/components/context/ActionsContext";
import { generateCredentials } from "opds-web-client/lib/utils/auth";
import {
  AuthMethod,
  AuthProvider,
  BasicAuthMethod
} from "opds-web-client/lib/interfaces";
import { AuthFormProps } from "opds-web-client/lib/components/AuthProviderSelectionForm";

type FormData = {
  barcode: string;
  pin: string;
};

/**
 * Auth form
 */
const BasicAuthForm: React.FC<AuthFormProps<BasicAuthMethod>> = ({
  provider
}) => {
  const authState = useTypedSelector(state => state.auth);
  const { callback, error: serverError } = authState;
  const { actions, dispatch } = useActions();
  const { register, handleSubmit, errors } = useForm<FormData>();

  const onSubmit = ({ barcode, pin }) => {
    // create credentials
    const credentials = generateCredentials(barcode, pin);
    // save them with redux
    dispatch(
      actions.saveAuthCredentials({
        provider: provider.id,
        credentials
      })
    );
    // call the callback that was saved when the form was triggered
    callback?.();
  };
  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      sx={{ display: "flex", flexDirection: "column" }}
    >
      <span sx={{ color: "warn" }}>{serverError}</span>
      <FormInput
        name="barcode"
        label="Barcode"
        id="barcode"
        placeholder="Barcode"
        ref={register({ required: true, maxLength: 25 })}
        error={errors?.barcode && "Your barcode is required."}
      />
      <FormInput
        name="pin"
        label="Pin"
        ref={register({ required: true, maxLength: 25 })}
        id="pin"
        type="password"
        placeholder="Pin"
        error={errors?.pin && "Your pin is required."}
      />
      <Button type="submit" sx={{ alignSelf: "flex-end", m: 2 }}>
        Login
      </Button>
    </form>
  );
};

export default BasicAuthForm;
